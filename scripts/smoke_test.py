"""End-to-end smoke test: parse → aggregate → analyze on the sample export."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from healthkit import (  # noqa: E402
    build_daily_frame,
    compute_env_stress,
    compute_readiness,
    correlation_matrix,
    detect_anomalies,
    generate_insights,
    lagged_correlations,
    parse_export,
    rolling_view,
)


def main() -> int:
    sample = ROOT / "sample_data" / "export.xml"
    if not sample.exists():
        print(f"missing {sample}; run scripts/make_sample_export.py first")
        return 1

    per_metric = parse_export(sample)
    print(f"parsed metrics: {sorted(per_metric.keys())}")
    for k, v in per_metric.items():
        print(f"  {k:14s} rows={len(v):6d}  date_range={v['start'].min().date()} … {v['start'].max().date()}")

    daily = build_daily_frame(per_metric)
    print(f"\ndaily frame: {daily.shape[0]} days × {daily.shape[1]} cols")
    print(f"columns: {list(daily.columns)}")
    assert "sleep_hours" in daily.columns
    assert "resting_hr" in daily.columns
    assert daily["sleep_hours"].notna().sum() > 50

    smoothed = rolling_view(daily, window=7)
    # rolling_view operates on _numeric_view which excludes the rolling-baseline
    # and z-score columns (Phase 2 derived inputs to Phase 3 scores).
    derived_cols = [c for c in daily.columns
                    if c.endswith("_baseline30") or c.endswith("_zscore30")]
    assert smoothed.shape[0] == daily.shape[0]
    assert smoothed.shape[1] == daily.select_dtypes("number").shape[1] - len(derived_cols)

    readiness = compute_readiness(daily)
    env_stress = compute_env_stress(daily)
    print(f"\nreadiness: {readiness.notna().sum()} days, latest={readiness.dropna().iloc[-1]:.1f}")
    print(f"env_stress: {env_stress.notna().sum()} days, latest={env_stress.dropna().iloc[-1]:.1f}")
    assert readiness.notna().sum() > 50
    assert env_stress.notna().sum() > 50

    corr = correlation_matrix(daily)
    print(f"\ncorrelation matrix: {corr.shape}")
    assert not corr.empty

    lc = lagged_correlations(
        daily,
        drivers=["sleep_hours", "steps"],
        responses=["resting_hr", "hrv"],
        lags=(0, 1, 2),
    )
    print(f"lagged correlations: {len(lc)} pairs (top 3 by |r|):")
    print(lc.head(3).to_string(index=False))
    assert not lc.empty

    anom = detect_anomalies(daily, sigma=2.0)
    print(f"\nanomalies flagged: {len(anom)}")
    if not anom.empty:
        print(anom.head(5).to_string(index=False))

    insights = generate_insights(daily)
    print(f"\ninsights generated: {len(insights)}")
    for ins in insights[:6]:
        print(f"  [{ins.severity}] {ins.title}")
        print(f"        {ins.detail}")

    print("\nOK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
