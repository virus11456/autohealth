"""Roll the per-record DataFrames into a single daily frame for analysis."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .parser import SUPPORTED_TYPES, metric_index


# Metrics that get a 30-day rolling baseline + z-score column. Picked because
# Phase 3 Readiness/Environment scores read these baselines; adding more is cheap.
BASELINE_METRICS = (
    "resting_hr", "hrv", "respiratory", "sleep_score", "spo2", "daylight",
    "walking_hr", "wrist_temp_delta_c",
)


# Sleep "day" rule: a session that ends after noon belongs to that calendar day;
# one ending at e.g. 06:00 belongs to the same calendar day. We attribute each
# session to the date of its END timestamp, which matches how Apple Health UI
# groups sleep.
def _sleep_daily(sleep: pd.DataFrame) -> pd.DataFrame:
    if sleep.empty:
        return pd.DataFrame()

    s = sleep.copy()
    s["date"] = s["end"].dt.normalize()
    s["minutes"] = (s["end"] - s["start"]).dt.total_seconds() / 60.0

    asleep_stages = {"Asleep", "AsleepCore", "AsleepDeep", "AsleepREM", "AsleepUnspecified"}
    in_bed_stages = {"InBed"}

    s["is_asleep"] = s["stage"].isin(asleep_stages)
    s["is_in_bed"] = s["stage"].isin(in_bed_stages)
    s["is_deep"] = s["stage"] == "AsleepDeep"
    s["is_rem"] = s["stage"] == "AsleepREM"
    s["is_awake"] = s["stage"] == "Awake"

    grouped = s.groupby("date")
    daily = pd.DataFrame({
        "sleep_minutes": grouped.apply(lambda g: g.loc[g["is_asleep"], "minutes"].sum()
                                       or g.loc[g["is_in_bed"], "minutes"].sum()),
        "sleep_deep_minutes": grouped.apply(lambda g: g.loc[g["is_deep"], "minutes"].sum()),
        "sleep_rem_minutes": grouped.apply(lambda g: g.loc[g["is_rem"], "minutes"].sum()),
        "sleep_awake_minutes": grouped.apply(lambda g: g.loc[g["is_awake"], "minutes"].sum()),
        "sleep_start": grouped.apply(lambda g: g["start"].min()),
        "sleep_end": grouped.apply(lambda g: g["end"].max()),
    })
    daily["sleep_hours"] = daily["sleep_minutes"] / 60.0

    # 0-100 sleep score: 50% duration vs 7.5h target + 25% deep ratio vs 20%
    # + 25% REM ratio vs 25%. Mirrors scripts/parse_health.py so the standalone
    # CLI and the library produce comparable values.
    deep_h = daily["sleep_deep_minutes"] / 60.0
    rem_h = daily["sleep_rem_minutes"] / 60.0
    asleep_h = daily["sleep_hours"]
    with np.errstate(divide="ignore", invalid="ignore"):
        dur_score = np.minimum(asleep_h / 7.5, 1.0) * 50
        deep_ratio = np.where(asleep_h > 0, deep_h / asleep_h, 0)
        rem_ratio = np.where(asleep_h > 0, rem_h / asleep_h, 0)
        deep_score = np.minimum(deep_ratio / 0.20, 1.0) * 25
        rem_score = np.minimum(rem_ratio / 0.25, 1.0) * 25
    score = pd.Series(dur_score + deep_score + rem_score, index=daily.index)
    daily["sleep_score"] = score.where(asleep_h >= 1.0).round(1)

    # bedtime as minutes-after-18:00 so 23:30 -> 330, 01:00 -> 420
    def _bedtime_offset(ts: pd.Timestamp) -> float:
        if pd.isna(ts):
            return np.nan
        ref = ts.normalize() if ts.hour >= 18 else ts.normalize() - pd.Timedelta(days=1)
        ref = ref + pd.Timedelta(hours=18)
        return (ts - ref).total_seconds() / 60.0

    daily["bedtime_offset_min"] = daily["sleep_start"].map(_bedtime_offset)

    # bedtime_hour: 23:30 → 23.5、01:30 → 25.5（24+ 形式方便當作 scalar 用）
    def _bedtime_hour(ts: pd.Timestamp) -> float:
        if pd.isna(ts):
            return np.nan
        h = ts.hour + ts.minute / 60.0
        return h + 24 if h < 12 else h
    daily["bedtime_hour"] = daily["sleep_start"].map(_bedtime_hour).round(2)

    # sleep efficiency if we have both in-bed and asleep records
    in_bed_min = grouped.apply(lambda g: g.loc[g["is_in_bed"], "minutes"].sum())
    daily["sleep_efficiency"] = np.where(
        in_bed_min > 0, daily["sleep_minutes"] / in_bed_min, np.nan
    )
    return daily


def _quantity_daily(key: str, df: pd.DataFrame) -> pd.Series:
    spec = metric_index()[key]
    s = df.copy()
    s["date"] = s["start"].dt.normalize()
    grouped = s.groupby("date")["value"]
    if spec.aggregation == "sum":
        return grouped.sum()
    if spec.aggregation == "mean":
        return grouped.mean()
    if spec.aggregation == "min":
        return grouped.min()
    if spec.aggregation == "max":
        return grouped.max()
    return grouped.mean()


def _hr_derived_daily(hr_df: pd.DataFrame) -> pd.DataFrame:
    """Per-day min / max / std / sample-count for raw heart-rate records.

    Mean is already computed via the standard 'hr' rollup; these companions let
    downstream analyses look at HR spread (training intensity proxy) without
    keeping every raw sample around.
    """
    s = hr_df.copy()
    s["date"] = s["start"].dt.normalize()
    grouped = s.groupby("date")["value"]
    out = pd.DataFrame({
        "heart_rate_min": grouped.min(),
        "heart_rate_max": grouped.max(),
        "heart_rate_std": grouped.std(ddof=1),
        "heart_rate_samples": grouped.count().astype("int64"),
    })
    return out


def _attach_baselines(daily: pd.DataFrame, cols: tuple[str, ...] = BASELINE_METRICS,
                     window: int = 30, min_periods: int = 7) -> None:
    """Add `{col}_baseline30` and `{col}_zscore30` for each metric in cols."""
    for col in cols:
        if col not in daily.columns:
            continue
        s = daily[col]
        mean = s.rolling(window, min_periods=min_periods).mean()
        std = s.rolling(window, min_periods=min_periods).std(ddof=1)
        daily[f"{col}_baseline30"] = mean
        daily[f"{col}_zscore30"] = (s - mean) / std.replace(0, np.nan)


def build_daily_frame(per_metric: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Combine all metrics into one DataFrame indexed by date."""
    columns: dict[str, pd.Series] = {}

    for spec in SUPPORTED_TYPES:
        df = per_metric.get(spec.key)
        if df is None or df.empty:
            continue
        columns[spec.key] = _quantity_daily(spec.key, df)

    sleep = per_metric.get("sleep")
    if sleep is not None and not sleep.empty:
        sleep_daily = _sleep_daily(sleep)
        for col in sleep_daily.columns:
            columns[col] = sleep_daily[col]

    if not columns:
        return pd.DataFrame()

    daily = pd.concat(columns, axis=1)
    daily.index = pd.to_datetime(daily.index).normalize()
    daily.index.name = "date"
    daily = daily.sort_index()

    # HR derivations (min/max/std/samples) from raw records
    hr_df = per_metric.get("hr")
    if hr_df is not None and not hr_df.empty:
        hr_extra = _hr_derived_daily(hr_df)
        hr_extra.index = pd.to_datetime(hr_extra.index).normalize()
        for col in hr_extra.columns:
            daily[col] = hr_extra[col]

    # derived: nighttime SpO2 minimum approximated via daily min if records overlap sleep
    spo2_df = per_metric.get("spo2")
    sleep_df = per_metric.get("sleep")
    if spo2_df is not None and sleep_df is not None and not spo2_df.empty and not sleep_df.empty:
        daily["spo2_sleep_min"] = _spo2_during_sleep(spo2_df, sleep_df)

    _attach_baselines(daily)

    return daily


def _spo2_during_sleep(spo2: pd.DataFrame, sleep: pd.DataFrame) -> pd.Series:
    """For each sleep day, find min SpO2 reading taken during a sleep window."""
    asleep_stages = {"Asleep", "AsleepCore", "AsleepDeep", "AsleepREM", "AsleepUnspecified", "InBed"}
    sessions = sleep[sleep["stage"].isin(asleep_stages)].copy()
    if sessions.empty:
        return pd.Series(dtype=float)

    sessions["date"] = sessions["end"].dt.normalize()
    # interval join: for each spo2 reading, find sleep session covering it
    spo2_sorted = spo2.sort_values("start").reset_index(drop=True)
    sessions_sorted = sessions.sort_values("start").reset_index(drop=True)

    # naive but bounded: use searchsorted on session starts
    starts = sessions_sorted["start"].values
    ends = sessions_sorted["end"].values
    dates = sessions_sorted["date"].values

    out: dict[pd.Timestamp, float] = {}
    idx = 0
    for ts, val in zip(spo2_sorted["start"].values, spo2_sorted["value"].values):
        while idx < len(starts) and ends[idx] < ts:
            idx += 1
        # try this and the previous session
        for j in (idx - 1, idx):
            if 0 <= j < len(starts) and starts[j] <= ts <= ends[j]:
                d = pd.Timestamp(dates[j])
                cur = out.get(d)
                out[d] = val if cur is None else min(cur, val)
                break
    if not out:
        return pd.Series(dtype=float)
    return pd.Series(out).sort_index()
