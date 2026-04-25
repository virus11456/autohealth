"""Cross-dimensional analysis: correlations, anomalies, trends, insights."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy import stats


# Phase 3 composite scores. Each takes the z-score columns produced by
# aggregator._attach_baselines() and combines them into a 0-100 daily score.
# Convention: a metric's directional contribution is +z if "higher is better"
# for that score, -z if "lower is better", -|z| if "closer to baseline is
# better". Components average; missing components are skipped (need >= 2/4).

# (zscore_column, sign) — sign = +1 / -1 / "abs" (penalize either direction)
READINESS_COMPONENTS = (
    ("hrv_zscore30",          +1),     # higher HRV = better recovery
    ("resting_hr_zscore30",   -1),     # lower RHR = better recovery
    ("sleep_score_zscore30",  +1),     # higher sleep score = better
    ("respiratory_zscore30",  "abs"),  # closer to personal baseline = better
)

ENV_STRESS_COMPONENTS = (
    ("daylight_zscore30",      -1),    # less daylight = more env stress
    ("spo2_zscore30",          -1),    # lower SpO2 = more stress
    ("respiratory_zscore30",   +1),    # higher respiratory = stress signal
    ("hrv_zscore30",           -1),    # lower HRV = more stress
)


def _composite_score(daily, components, slope: float = 20.0, midpoint: float = 50.0) -> "pd.Series":
    """Average directional z-scores → 0-100. ±2σ ≈ 90/10, ±2.5σ saturates."""
    import numpy as np
    import pandas as pd

    parts = []
    for col, sign in components:
        if col not in daily.columns:
            continue
        s = daily[col]
        if sign == "abs":
            parts.append(-s.abs())
        else:
            parts.append(s * sign)
    if not parts:
        return pd.Series(dtype=float, index=daily.index)
    stacked = pd.concat(parts, axis=1)
    # require >= 2 non-NaN components per day
    good = stacked.notna().sum(axis=1) >= 2
    z_avg = stacked.mean(axis=1, skipna=True)
    score = (midpoint + slope * z_avg).clip(0, 100)
    return score.where(good).rename(None)


def compute_readiness(daily: "pd.DataFrame") -> "pd.Series":
    """0-100 daily Readiness Score (HRV, RHR, sleep_score, respiratory)."""
    return _composite_score(daily, READINESS_COMPONENTS)


def compute_env_stress(daily: "pd.DataFrame") -> "pd.Series":
    """0-100 daily Environment Stress Score (daylight, SpO2, respiratory, HRV)."""
    return _composite_score(daily, ENV_STRESS_COMPONENTS)


METRIC_LABELS_ZH = {
    "steps": "步數",
    "active_energy": "活動消耗",
    "distance": "步行距離",
    "flights": "爬樓層",
    "hr": "平均心率",
    "resting_hr": "靜息心率",
    "walking_hr": "步行心率",
    "hrv": "HRV",
    "spo2": "血氧 (日均)",
    "spo2_sleep_min": "睡眠期間最低血氧",
    "respiratory": "呼吸頻率",
    "body_temp": "體溫",
    "vo2max": "VO2 Max",
    "sleep_hours": "睡眠時數",
    "sleep_deep_minutes": "深睡分鐘",
    "sleep_rem_minutes": "REM 分鐘",
    "sleep_awake_minutes": "夜間清醒分鐘",
    "sleep_efficiency": "睡眠效率",
    "bedtime_offset_min": "就寢時點 (18:00 後分鐘)",
    "walking_asymmetry": "步行不對稱率",
    "double_support": "雙腳支撐時間",
    "daylight": "日照時間",
    "sleep_score": "睡眠分數",
    "hr_min": "心率最低",
    "hr_max": "心率最高",
    "hr_std": "心率波動 (std)",
    "hr_samples": "心率樣本數",
    "readiness": "恢復分數",
    "env_stress": "環境壓力分數",
}


def _numeric_view(daily: pd.DataFrame) -> pd.DataFrame:
    drop_cols = [c for c in ("sleep_start", "sleep_end") if c in daily.columns]
    # Exclude derived rolling-baseline / z-score columns from correlation, anomaly,
    # and lag analyses — they're inputs to Phase 3 Readiness/EnvStress, not
    # first-class signals on their own.
    derived = [c for c in daily.columns if c.endswith("_baseline30") or c.endswith("_zscore30")]
    return daily.drop(columns=drop_cols + derived, errors="ignore").select_dtypes(include="number")


def rolling_view(daily: pd.DataFrame, window: int = 7) -> pd.DataFrame:
    num = _numeric_view(daily)
    return num.rolling(window=window, min_periods=max(2, window // 2)).mean()


def correlation_matrix(daily: pd.DataFrame, min_overlap: int = 14) -> pd.DataFrame:
    num = _numeric_view(daily)
    cols = [c for c in num.columns if num[c].notna().sum() >= min_overlap]
    if len(cols) < 2:
        return pd.DataFrame()
    return num[cols].corr(method="spearman", min_periods=min_overlap)


def lagged_correlations(
    daily: pd.DataFrame,
    drivers: list[str],
    responses: list[str],
    lags: tuple[int, ...] = (-2, -1, 0, 1, 2),
    min_overlap: int = 14,
) -> pd.DataFrame:
    """For each (driver, response, lag), compute Spearman r where response is
    shifted by `lag` days (positive lag = response measured `lag` days after driver).
    """
    num = _numeric_view(daily)
    rows = []
    for d in drivers:
        if d not in num.columns:
            continue
        for r in responses:
            if r not in num.columns or r == d:
                continue
            for lag in lags:
                shifted = num[r].shift(-lag)
                pair = pd.concat([num[d], shifted], axis=1).dropna()
                if len(pair) < min_overlap:
                    continue
                rho, p = stats.spearmanr(pair.iloc[:, 0], pair.iloc[:, 1])
                if np.isnan(rho):
                    continue
                rows.append({
                    "driver": d,
                    "response": r,
                    "lag_days": lag,
                    "spearman_r": rho,
                    "p_value": p,
                    "n": len(pair),
                })
    return pd.DataFrame(rows).sort_values(
        by=["spearman_r"], key=lambda s: s.abs(), ascending=False
    )


def detect_anomalies(daily: pd.DataFrame, sigma: float = 2.0, baseline_days: int = 28) -> pd.DataFrame:
    """Flag days where a metric deviates from its rolling baseline by >= sigma σ."""
    num = _numeric_view(daily)
    out = []
    for col in num.columns:
        s = num[col].dropna()
        if len(s) < baseline_days:
            continue
        mean = s.rolling(baseline_days, min_periods=baseline_days // 2).mean()
        std = s.rolling(baseline_days, min_periods=baseline_days // 2).std()
        z = (s - mean) / std.replace(0, np.nan)
        flagged = z.abs() >= sigma
        for date, is_flag in flagged.items():
            if is_flag and not pd.isna(z.loc[date]):
                out.append({
                    "date": date,
                    "metric": col,
                    "value": float(s.loc[date]),
                    "baseline_mean": float(mean.loc[date]),
                    "z_score": float(z.loc[date]),
                })
    if not out:
        return pd.DataFrame()
    return pd.DataFrame(out).sort_values("date", ascending=False)


@dataclass
class Insight:
    title: str
    detail: str
    severity: str  # info | watch | alert


def _label(col: str) -> str:
    return METRIC_LABELS_ZH.get(col, col)


def _trend_change(series: pd.Series, recent: int = 7, prior: int = 21) -> tuple[float, float] | None:
    """Return (recent_mean, prior_mean) if both windows are sufficiently populated."""
    s = series.dropna()
    if len(s) < recent + 5:
        return None
    recent_part = s.iloc[-recent:]
    prior_part = s.iloc[-(recent + prior):-recent] if len(s) >= recent + prior else s.iloc[:-recent]
    if len(recent_part) < max(3, recent // 2) or len(prior_part) < max(5, prior // 3):
        return None
    return float(recent_part.mean()), float(prior_part.mean())


def generate_insights(daily: pd.DataFrame) -> list[Insight]:
    """Heuristic narrative insights: trend shifts + notable correlations."""
    insights: list[Insight] = []
    num = _numeric_view(daily)

    # 1. Trend shifts on key metrics
    watch_metrics = [
        ("resting_hr", "higher_is_worse"),
        ("hrv", "higher_is_better"),
        ("sleep_hours", "higher_is_better"),
        ("sleep_efficiency", "higher_is_better"),
        ("spo2", "higher_is_better"),
        ("spo2_sleep_min", "higher_is_better"),
        ("steps", "higher_is_better"),
        ("respiratory", "neutral"),
        ("body_temp", "neutral"),
    ]
    for col, direction in watch_metrics:
        if col not in num.columns:
            continue
        change = _trend_change(num[col])
        if change is None:
            continue
        recent, prior = change
        if prior == 0 or np.isnan(prior):
            continue
        delta_pct = (recent - prior) / abs(prior) * 100
        if abs(delta_pct) < 5:
            continue

        verb = "上升" if delta_pct > 0 else "下降"
        sev = "info"
        bad = (
            (direction == "higher_is_worse" and delta_pct > 5) or
            (direction == "higher_is_better" and delta_pct < -5)
        )
        if bad:
            sev = "watch" if abs(delta_pct) < 15 else "alert"

        title = f"{_label(col)}近 7 天{verb} {abs(delta_pct):.1f}%"
        detail = f"近 7 天平均 {recent:.2f}，先前 {len(num[col].dropna()) > 28 and '21 天' or '基準期'}平均 {prior:.2f}。"
        insights.append(Insight(title=title, detail=detail, severity=sev))

    # 2. Top lagged correlation insights
    drivers = [c for c in ("sleep_hours", "sleep_efficiency", "steps", "active_energy", "bedtime_offset_min") if c in num.columns]
    responses = [c for c in ("resting_hr", "hrv", "spo2", "spo2_sleep_min", "sleep_efficiency", "sleep_hours") if c in num.columns]
    lc = lagged_correlations(daily, drivers, responses, lags=(0, 1, 2))
    if not lc.empty:
        # keep significant + meaningful effect size
        sig = lc[(lc["p_value"] < 0.05) & (lc["spearman_r"].abs() >= 0.25)]
        for _, row in sig.head(5).iterrows():
            d = _label(row["driver"])
            r = _label(row["response"])
            sign = "正相關" if row["spearman_r"] > 0 else "負相關"
            lag = int(row["lag_days"])
            lag_text = "同一天" if lag == 0 else f"延後 {lag} 天"
            insights.append(Insight(
                title=f"{d} 與 {r}（{lag_text}）呈{sign} (r={row['spearman_r']:+.2f})",
                detail=f"基於 {int(row['n'])} 天樣本，p={row['p_value']:.3f}。可作為調整生活作息的參考訊號。",
                severity="info",
            ))

    # 3. Recent anomalies (last 14 days)
    anom = detect_anomalies(daily)
    if not anom.empty:
        recent_anom = anom[anom["date"] >= (daily.index.max() - pd.Timedelta(days=14))]
        for _, row in recent_anom.head(5).iterrows():
            direction = "高於" if row["z_score"] > 0 else "低於"
            sev = "watch" if abs(row["z_score"]) < 3 else "alert"
            insights.append(Insight(
                title=f"{row['date'].strftime('%m/%d')} {_label(row['metric'])}異常 ({direction}基準 {abs(row['z_score']):.1f}σ)",
                detail=f"當日 {row['value']:.2f}，前 28 天基準平均 {row['baseline_mean']:.2f}。",
                severity=sev,
            ))

    return insights
