"""Generate a small synthetic Apple Health export.xml for smoke-testing.

Writes ./sample_data/export.xml. Not committed to git (data/ ignored), but
re-runnable. Synthesized values include realistic correlations so the
analyzer has something interesting to find.
"""
from __future__ import annotations

import math
import random
from datetime import datetime, timedelta
from pathlib import Path
from xml.sax.saxutils import escape

random.seed(42)

OUT = Path(__file__).resolve().parent.parent / "sample_data" / "export.xml"
OUT.parent.mkdir(parents=True, exist_ok=True)

DAYS = 120
start_date = datetime(2026, 1, 1, 0, 0, 0)


def fmt(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S +0000")


def record(rtype: str, unit: str, value: str, start: datetime, end: datetime, source="iPhone") -> str:
    return (
        f'<Record type="{rtype}" sourceName="{source}" '
        f'unit="{unit}" startDate="{fmt(start)}" endDate="{fmt(end)}" '
        f'value="{escape(str(value))}"/>'
    )


def hrv_record(value: float, start: datetime, end: datetime, source="Watch") -> str:
    """HRV records always carry a HeartRateVariabilityMetadataList child in
    real Apple Health exports. We emit one here so smoke tests cover the
    non-self-closing <Record>...</Record> form (the JS regex used to drop
    these — see commit history)."""
    return (
        f'<Record type="HKQuantityTypeIdentifierHeartRateVariabilitySDNN" '
        f'sourceName="{source}" unit="ms" startDate="{fmt(start)}" '
        f'endDate="{fmt(end)}" value="{escape(str(value))}">\n'
        f'  <HeartRateVariabilityMetadataList>\n'
        f'    <InstantaneousBeatsPerMinute bpm="60" time="{fmt(start)}"/>\n'
        f'    <InstantaneousBeatsPerMinute bpm="62" time="{fmt(start)}"/>\n'
        f'  </HeartRateVariabilityMetadataList>\n'
        f'</Record>'
    )


def record_with_metadata(rtype: str, unit: str, value, start: datetime,
                         end: datetime, meta_key: str, source="Watch") -> str:
    """Quantity record wrapping a single MetadataEntry child — exercises the
    same multi-line <Record>...</Record> form for SpO2/sleep that real
    exports often produce."""
    return (
        f'<Record type="{rtype}" sourceName="{source}" '
        f'unit="{unit}" startDate="{fmt(start)}" endDate="{fmt(end)}" '
        f'value="{escape(str(value))}">\n'
        f'  <MetadataEntry key="{meta_key}" value="1"/>\n'
        f'</Record>'
    )


def category(rtype: str, value: str, start: datetime, end: datetime, source="Watch") -> str:
    return (
        f'<Record type="{rtype}" sourceName="{source}" '
        f'startDate="{fmt(start)}" endDate="{fmt(end)}" value="{value}"/>'
    )


lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<HealthData>"]

for d in range(DAYS):
    day = start_date + timedelta(days=d)

    # weekly cycle + slow trend so insights have something to find
    weekday = day.weekday()
    weekly = math.sin(2 * math.pi * d / 7)
    trend = d / DAYS

    sleep_hours = max(4.5, 7.4 + 0.6 * weekly - 0.5 * trend + random.gauss(0, 0.4))
    sleep_efficiency = min(0.97, 0.88 + 0.04 * weekly + random.gauss(0, 0.03))

    # resting HR inversely related to sleep + HRV; rises with trend
    resting_hr = 60 - 1.8 * (sleep_hours - 7) + 4 * trend + random.gauss(0, 1.5)
    hrv = 55 + 5 * (sleep_hours - 7) - 8 * trend + random.gauss(0, 4)
    spo2_base = 97.5 + random.gauss(0, 0.4)
    steps = max(0, int(8500 + 4000 * weekly - 1500 * (weekday >= 5) + random.gauss(0, 1500)))
    active_kcal = max(50, 350 + 0.04 * steps + random.gauss(0, 60))
    distance_km = steps * 0.00075
    flights = max(0, int(8 + random.gauss(0, 4)))
    resp = 14 + random.gauss(0, 1.2)
    body_temp = 36.6 + random.gauss(0, 0.15)

    # gait + environment metrics
    # asymmetry climbs slightly on high-step days (overload proxy);
    # double-support tracks asymmetry; daylight tracks sleep (circadian proxy).
    overload = max(0, (steps - 9000) / 4000)
    walking_asym = max(0.4, 1.8 + 1.4 * overload + random.gauss(0, 0.4))
    double_support = max(20.0, 26.0 + 0.6 * walking_asym + random.gauss(0, 1.2))
    daylight_min = max(0, 45 + 12 * (sleep_hours - 7) - 25 * (weekday >= 5) + random.gauss(0, 12))

    # inject a couple of clear anomalies
    if d == 80:
        resting_hr += 12
        hrv -= 20
        spo2_base -= 2
    if d == 100:
        sleep_hours = 3.5
        sleep_efficiency = 0.62

    # sleep session ending at day 07:30
    sleep_end = day.replace(hour=7, minute=30)
    sleep_start = sleep_end - timedelta(hours=sleep_hours)
    in_bed_minutes = sleep_hours * 60 / max(0.5, sleep_efficiency)
    in_bed_start = sleep_end - timedelta(minutes=in_bed_minutes)

    lines.append(category(
        "HKCategoryTypeIdentifierSleepAnalysis",
        "HKCategoryValueSleepAnalysisInBed",
        in_bed_start, sleep_end,
    ))
    # split asleep into core/deep/rem
    deep = sleep_hours * 0.18
    rem = sleep_hours * 0.22
    core = sleep_hours - deep - rem
    cursor = sleep_start
    for stage_value, hours in (
        ("HKCategoryValueSleepAnalysisAsleepCore", core),
        ("HKCategoryValueSleepAnalysisAsleepDeep", deep),
        ("HKCategoryValueSleepAnalysisAsleepREM", rem),
    ):
        seg_end = cursor + timedelta(hours=hours)
        lines.append(category(
            "HKCategoryTypeIdentifierSleepAnalysis", stage_value, cursor, seg_end,
        ))
        cursor = seg_end

    # daily quantity records (one per day for simplicity; parser aggregates same)
    noon = day.replace(hour=12)
    lines.append(record("HKQuantityTypeIdentifierStepCount", "count", steps, noon, noon + timedelta(minutes=1)))
    lines.append(record("HKQuantityTypeIdentifierActiveEnergyBurned", "kcal", round(active_kcal, 1), noon, noon + timedelta(minutes=1)))
    lines.append(record("HKQuantityTypeIdentifierDistanceWalkingRunning", "km", round(distance_km, 3), noon, noon + timedelta(minutes=1)))
    lines.append(record("HKQuantityTypeIdentifierFlightsClimbed", "count", flights, noon, noon + timedelta(minutes=1)))
    lines.append(record("HKQuantityTypeIdentifierRestingHeartRate", "count/min", round(resting_hr, 1), noon, noon + timedelta(minutes=1)))
    lines.append(hrv_record(round(max(5, hrv), 1), noon, noon + timedelta(minutes=1)))
    lines.append(record("HKQuantityTypeIdentifierRespiratoryRate", "count/min", round(resp, 1), noon, noon + timedelta(minutes=1)))
    lines.append(record("HKQuantityTypeIdentifierBodyTemperature", "degC", round(body_temp, 2), noon, noon + timedelta(minutes=1)))
    lines.append(record("HKQuantityTypeIdentifierWalkingAsymmetryPercentage", "%", round(walking_asym, 2), noon, noon + timedelta(minutes=1)))
    lines.append(record("HKQuantityTypeIdentifierWalkingDoubleSupportPercentage", "%", round(double_support, 2), noon, noon + timedelta(minutes=1)))

    # daylight: split across two outdoor windows so the parser sums multiple records
    morning = day.replace(hour=10)
    afternoon = day.replace(hour=15)
    am_min = round(daylight_min * 0.55, 1)
    pm_min = round(daylight_min - am_min, 1)
    lines.append(record("HKQuantityTypeIdentifierTimeInDaylight", "min", am_min, morning, morning + timedelta(minutes=am_min)))
    lines.append(record("HKQuantityTypeIdentifierTimeInDaylight", "min", pm_min, afternoon, afternoon + timedelta(minutes=pm_min)))
    for h in (8, 12, 18, 22):
        ts = day.replace(hour=h)
        hr_val = resting_hr + random.uniform(5, 35) + (10 if h == 18 else 0)
        lines.append(record("HKQuantityTypeIdentifierHeartRate", "count/min", round(hr_val, 1), ts, ts + timedelta(seconds=30)))

    # SpO2 readings, including a few during sleep. The first SpO2 of each day
    # is emitted with a MetadataEntry child to exercise the non-self-closing
    # <Record>...</Record> form that real Apple Health exports produce.
    for i, h in enumerate((3, 5, 14)):
        ts = day.replace(hour=h)
        val = spo2_base + random.gauss(0, 0.6)
        clamped = round(min(100, max(85, val)), 1)
        if i == 0:
            lines.append(record_with_metadata(
                "HKQuantityTypeIdentifierOxygenSaturation", "%", clamped,
                ts, ts + timedelta(seconds=30),
                meta_key="HKMetadataKeyBackgroundFitnessAppleWatch",
            ))
        else:
            lines.append(record(
                "HKQuantityTypeIdentifierOxygenSaturation", "%", clamped,
                ts, ts + timedelta(seconds=30),
            ))

lines.append("</HealthData>")
OUT.write_text("\n".join(lines), encoding="utf-8")
print(f"wrote {OUT} ({OUT.stat().st_size/1024:.1f} KB)")
