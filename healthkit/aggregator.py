"""Roll the per-record DataFrames into a single daily frame for analysis."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .parser import SUPPORTED_TYPES, metric_index


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

    # bedtime as minutes-after-18:00 so 23:30 -> 330, 01:00 -> 420
    def _bedtime_offset(ts: pd.Timestamp) -> float:
        if pd.isna(ts):
            return np.nan
        ref = ts.normalize() if ts.hour >= 18 else ts.normalize() - pd.Timedelta(days=1)
        ref = ref + pd.Timedelta(hours=18)
        return (ts - ref).total_seconds() / 60.0

    daily["bedtime_offset_min"] = daily["sleep_start"].map(_bedtime_offset)

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

    # derived: nighttime SpO2 minimum approximated via daily min if records overlap sleep
    spo2_df = per_metric.get("spo2")
    sleep_df = per_metric.get("sleep")
    if spo2_df is not None and sleep_df is not None and not spo2_df.empty and not sleep_df.empty:
        daily["spo2_sleep_min"] = _spo2_during_sleep(spo2_df, sleep_df)

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
