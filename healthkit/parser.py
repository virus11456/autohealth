"""Stream-parse Apple Health export.xml.

Apple Health exports are often >100MB; we use iterparse and clear elements as we
go so memory stays bounded. Returns one tidy DataFrame per supported metric.
"""
from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Iterable, Mapping
from xml.etree import ElementTree as ET

import pandas as pd
from dateutil import parser as dtparser


@dataclass(frozen=True)
class MetricSpec:
    key: str          # short name used in the dashboard
    hk_type: str      # HealthKit identifier in export.xml
    label_zh: str     # Chinese label for UI
    unit: str         # canonical unit
    aggregation: str  # daily aggregation rule: sum / mean / min / max / sleep


SUPPORTED_TYPES: tuple[MetricSpec, ...] = (
    MetricSpec("steps", "HKQuantityTypeIdentifierStepCount", "步數", "步", "sum"),
    MetricSpec("active_energy", "HKQuantityTypeIdentifierActiveEnergyBurned", "活動消耗", "kcal", "sum"),
    MetricSpec("distance", "HKQuantityTypeIdentifierDistanceWalkingRunning", "步行距離", "km", "sum"),
    MetricSpec("flights", "HKQuantityTypeIdentifierFlightsClimbed", "爬樓層", "層", "sum"),
    MetricSpec("hr", "HKQuantityTypeIdentifierHeartRate", "心率", "bpm", "mean"),
    MetricSpec("resting_hr", "HKQuantityTypeIdentifierRestingHeartRate", "靜息心率", "bpm", "mean"),
    MetricSpec("walking_hr", "HKQuantityTypeIdentifierWalkingHeartRateAverage", "步行心率", "bpm", "mean"),
    MetricSpec("hrv", "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", "心率變異 (HRV)", "ms", "mean"),
    MetricSpec("spo2", "HKQuantityTypeIdentifierOxygenSaturation", "血氧", "%", "mean"),
    MetricSpec("respiratory", "HKQuantityTypeIdentifierRespiratoryRate", "呼吸頻率", "次/分", "mean"),
    MetricSpec("body_temp", "HKQuantityTypeIdentifierBodyTemperature", "體溫", "°C", "mean"),
    MetricSpec("vo2max", "HKQuantityTypeIdentifierVO2Max", "VO2 Max", "ml/kg·min", "mean"),
    MetricSpec("walking_asymmetry", "HKQuantityTypeIdentifierWalkingAsymmetryPercentage", "步行不對稱率", "%", "mean"),
    MetricSpec("double_support", "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage", "雙腳支撐時間", "%", "mean"),
    MetricSpec("daylight", "HKQuantityTypeIdentifierTimeInDaylight", "日照時間", "分鐘", "sum"),
    # New in Phase 5 prep — names align with scripts/parse_health.py canonical schema
    MetricSpec("hr_recovery_1min", "HKQuantityTypeIdentifierHeartRateRecoveryOneMinute", "1 分鐘心率恢復", "bpm", "mean"),
    MetricSpec("wrist_temp_delta_c", "HKQuantityTypeIdentifierAppleSleepingWristTemperature", "睡眠手腕溫差", "°C", "mean"),
    MetricSpec("walking_speed_mps", "HKQuantityTypeIdentifierWalkingSpeed", "步行速度", "m/s", "mean"),
    MetricSpec("step_length_cm", "HKQuantityTypeIdentifierWalkingStepLength", "步長", "cm", "mean"),
    MetricSpec("walking_steadiness", "HKQuantityTypeIdentifierAppleWalkingSteadiness", "步行穩定度", "%", "mean"),
    MetricSpec("six_min_walk_m", "HKQuantityTypeIdentifierSixMinuteWalkTestDistance", "6 分鐘步行距離", "m", "mean"),
    MetricSpec("basal_kcal", "HKQuantityTypeIdentifierBasalEnergyBurned", "基礎代謝", "kcal", "sum"),
    MetricSpec("exercise_minutes", "HKQuantityTypeIdentifierAppleExerciseTime", "運動時間", "分鐘", "sum"),
    MetricSpec("stand_minutes", "HKQuantityTypeIdentifierAppleStandTime", "站立時間", "分鐘", "sum"),
    MetricSpec("headphone_db", "HKQuantityTypeIdentifierHeadphoneAudioExposure", "耳機音量", "dB", "mean"),
    MetricSpec("env_audio_db", "HKQuantityTypeIdentifierEnvironmentalAudioExposure", "環境音量", "dB", "mean"),
    MetricSpec("body_mass_kg", "HKQuantityTypeIdentifierBodyMass", "體重", "kg", "mean"),
    MetricSpec("bmi", "HKQuantityTypeIdentifierBodyMassIndex", "BMI", "", "mean"),
)

SLEEP_TYPE = "HKCategoryTypeIdentifierSleepAnalysis"

_TYPE_INDEX: Mapping[str, MetricSpec] = {m.hk_type: m for m in SUPPORTED_TYPES}


# Apple translates the export filename per device locale, so en uses
# "export.xml" but zh-Hant gives "輸出.xml", zh-Hans "导出.xml", ja "エクスポート.xml".
_KNOWN_EXPORT_NAMES = ("export.xml", "輸出.xml", "导出.xml", "エクスポート.xml")


def _find_export_xml(namelist: list[str]) -> str | None:
    for known in _KNOWN_EXPORT_NAMES:
        for n in namelist:
            if n == known or n.endswith("/" + known):
                return n
    # Fallback: pick a non-CDA .xml sitting in the same directory as export_cda.xml.
    cda = next((n for n in namelist if n.lower().endswith("export_cda.xml")), None)
    prefix = cda.rsplit("/", 1)[0] + "/" if cda and "/" in cda else ""
    for n in namelist:
        ln = n.lower()
        if not ln.endswith(".xml") or ln.endswith("export_cda.xml"):
            continue
        if prefix:
            if n.startswith(prefix) and "/" not in n[len(prefix):]:
                return n
        elif n.count("/") <= 1:
            return n
    return None


def _missing_xml_error(namelist: list[str], where: str) -> ValueError:
    xmls = [n for n in namelist if n.lower().endswith(".xml")] or ["(無 .xml)"]
    return ValueError(f"{where} 內找不到 export.xml；zip 中的 .xml 檔：{xmls}")


def _open_xml(source: str | Path | IO[bytes]) -> IO[bytes]:
    """Accept a path/zip/file-like and return a binary file-like for export.xml."""
    if hasattr(source, "read"):
        head = source.read(4)
        source.seek(0)
        if head[:2] == b"PK":
            zf = zipfile.ZipFile(source)
            name = _find_export_xml(zf.namelist())
            if name is None:
                raise _missing_xml_error(zf.namelist(), "zip")
            return zf.open(name)
        return source  # assume plain XML stream

    path = Path(source)
    if path.suffix.lower() == ".zip":
        zf = zipfile.ZipFile(path)
        name = _find_export_xml(zf.namelist())
        if name is None:
            raise _missing_xml_error(zf.namelist(), str(path))
        return zf.open(name)
    return path.open("rb")


def _to_value(text: str | None) -> float | None:
    if text is None:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_export(source: str | Path | IO[bytes]) -> dict[str, pd.DataFrame]:
    """Parse an Apple Health export and return per-metric tidy DataFrames.

    Result keys: every MetricSpec.key that had data, plus 'sleep' if found.
    Quantity frames have columns: start, end, value, source.
    Sleep frame has columns: start, end, stage, source where stage is one of
    {InBed, Asleep, AsleepCore, AsleepDeep, AsleepREM, Awake}.
    """
    quantity_rows: dict[str, list[tuple]] = {m.key: [] for m in SUPPORTED_TYPES}
    sleep_rows: list[tuple] = []

    stream = _open_xml(source)
    context = ET.iterparse(stream, events=("end",))
    for _, elem in context:
        if elem.tag != "Record":
            continue
        rtype = elem.get("type")
        if rtype == SLEEP_TYPE:
            try:
                start = dtparser.parse(elem.get("startDate"))
                end = dtparser.parse(elem.get("endDate"))
            except (TypeError, ValueError):
                elem.clear()
                continue
            stage = (elem.get("value") or "").replace("HKCategoryValueSleepAnalysis", "")
            sleep_rows.append((start, end, stage, elem.get("sourceName", "")))
        else:
            spec = _TYPE_INDEX.get(rtype)
            if spec is None:
                elem.clear()
                continue
            value = _to_value(elem.get("value"))
            if value is None:
                elem.clear()
                continue
            try:
                start = dtparser.parse(elem.get("startDate"))
                end = dtparser.parse(elem.get("endDate"))
            except (TypeError, ValueError):
                elem.clear()
                continue
            # convert distance metres -> km if Apple emitted m
            unit = elem.get("unit", "")
            if spec.key == "distance" and unit.lower() in {"m", "meter", "metre"}:
                value = value / 1000.0
            quantity_rows[spec.key].append((start, end, value, elem.get("sourceName", "")))
        elem.clear()

    # Apple Health emits these percent metrics as either 0-1 fraction or 0-100
    # percent under unit="%", inconsistently. Normalize to percent: if max
    # observed value is ≤ 1.5, treat as fraction and scale ×100. Without this
    # SpO2 ends up displayed as 0.9 % (would imply death) instead of 90 %.
    percent_keys = {"spo2", "walking_asymmetry", "double_support", "walking_steadiness"}

    out: dict[str, pd.DataFrame] = {}
    for spec in SUPPORTED_TYPES:
        rows = quantity_rows[spec.key]
        if not rows:
            continue
        df = pd.DataFrame(rows, columns=["start", "end", "value", "source"])
        df["start"] = pd.to_datetime(df["start"], utc=True).dt.tz_convert(None)
        df["end"] = pd.to_datetime(df["end"], utc=True).dt.tz_convert(None)
        if spec.key in percent_keys and not df.empty and df["value"].max() <= 1.5:
            df["value"] = df["value"] * 100.0
        out[spec.key] = df.sort_values("start").reset_index(drop=True)

    if sleep_rows:
        sdf = pd.DataFrame(sleep_rows, columns=["start", "end", "stage", "source"])
        sdf["start"] = pd.to_datetime(sdf["start"], utc=True).dt.tz_convert(None)
        sdf["end"] = pd.to_datetime(sdf["end"], utc=True).dt.tz_convert(None)
        out["sleep"] = sdf.sort_values("start").reset_index(drop=True)

    return out


def metric_index() -> dict[str, MetricSpec]:
    return {m.key: m for m in SUPPORTED_TYPES}
