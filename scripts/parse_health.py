"""
Apple Health export.xml → 每日寬表 (CSV + Parquet)
指標：心率、HRV、心適能、日照、血氧、步數、步行不對稱率、
      呼吸頻率、睡眠分數、靜息心率、雙腳支撐時間、平均步行心率

用法：
    python parse_health.py /path/to/export.xml /path/to/output_dir
"""

import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from collections import defaultdict
from datetime import datetime
import pandas as pd

# ---- 指標對應表 ----
# Apple Health 的 type 字串 → 我們要的欄位名 + 聚合方式
METRIC_MAP = {
    # 心血管 / 自律神經
    "HKQuantityTypeIdentifierHeartRate":                    ("heart_rate_mean",          "mean"),
    "HKQuantityTypeIdentifierHeartRateVariabilitySDNN":     ("hrv_sdnn_ms",              "mean"),
    "HKQuantityTypeIdentifierRestingHeartRate":             ("resting_hr",               "mean"),
    "HKQuantityTypeIdentifierWalkingHeartRateAverage":      ("walking_hr_avg",           "mean"),
    "HKQuantityTypeIdentifierVO2Max":                       ("vo2_max",                  "mean"),

    # 呼吸 / 血氧
    "HKQuantityTypeIdentifierOxygenSaturation":             ("spo2_mean",                "mean"),
    "HKQuantityTypeIdentifierRespiratoryRate":              ("respiratory_rate",         "mean"),

    # 活動 / 步態
    "HKQuantityTypeIdentifierStepCount":                    ("steps",                    "sum"),
    "HKQuantityTypeIdentifierWalkingAsymmetryPercentage":   ("walking_asymmetry_pct",    "mean"),
    "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage":("double_support_pct",      "mean"),

    # 環境
    "HKQuantityTypeIdentifierTimeInDaylight":               ("daylight_minutes",         "sum"),
}

# 心率衍生指標：用全天心率算出 min / max / std（除了 mean 之外）
HR_TYPE = "HKQuantityTypeIdentifierHeartRate"

# 睡眠 type
SLEEP_TYPE = "HKCategoryTypeIdentifierSleepAnalysis"


def parse_date(s: str) -> datetime:
    # Apple Health 格式: '2026-03-15 23:45:12 +0800'
    return datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S")


def parse_records(xml_path: Path):
    """串流解析 XML，避免一次載入吃光記憶體"""
    quant = defaultdict(lambda: defaultdict(list))   # {date: {metric_col: [values]}}
    hr_per_day = defaultdict(list)                   # 心率原始值，算 min/max/std
    sleep_per_day = defaultdict(lambda: defaultdict(float))  # 睡眠各階段秒數

    print(f"[1/3] 解析 {xml_path} ...")
    count = 0

    # iterparse 串流模式
    for event, elem in ET.iterparse(str(xml_path), events=("end",)):
        if elem.tag != "Record":
            continue

        rtype = elem.get("type")
        start = elem.get("startDate")
        end_date = elem.get("endDate")
        value = elem.get("value")

        if not start:
            elem.clear(); continue

        try:
            dt = parse_date(start)
        except Exception:
            elem.clear(); continue

        date_key = dt.date().isoformat()

        # --- 數值型指標 ---
        if rtype in METRIC_MAP:
            col, _ = METRIC_MAP[rtype]
            try:
                v = float(value)
                quant[date_key][col].append(v)
                if rtype == HR_TYPE:
                    hr_per_day[date_key].append(v)
            except (TypeError, ValueError):
                pass

        # --- 睡眠 ---
        elif rtype == SLEEP_TYPE and end_date:
            try:
                dt_end = parse_date(end_date)
                duration_s = (dt_end - dt).total_seconds()
                # 睡眠歸屬到「醒來那天」：以結束時間的日期為準（睡眠科學常用作法）
                sleep_date = dt_end.date().isoformat()
                # value 範例: HKCategoryValueSleepAnalysisAsleepDeep / Core / REM / Awake / InBed
                stage = (value or "").replace("HKCategoryValueSleepAnalysis", "")
                sleep_per_day[sleep_date][stage] += duration_s
            except Exception:
                pass

        count += 1
        if count % 500_000 == 0:
            print(f"   已處理 {count:,} 筆 record...")

        elem.clear()

    print(f"   共處理 {count:,} 筆 record")
    return quant, hr_per_day, sleep_per_day


def build_dataframe(quant, hr_per_day, sleep_per_day) -> pd.DataFrame:
    print("[2/3] 聚合每日指標 ...")

    # 收集所有日期
    all_dates = set(quant.keys()) | set(hr_per_day.keys()) | set(sleep_per_day.keys())
    rows = []

    for d in sorted(all_dates):
        row = {"date": d}

        # 數值指標：按 METRIC_MAP 指定方式聚合
        for rtype, (col, agg) in METRIC_MAP.items():
            vals = quant[d].get(col, [])
            if not vals:
                row[col] = None
                continue
            if agg == "sum":
                row[col] = sum(vals)
            elif agg == "mean":
                row[col] = sum(vals) / len(vals)

        # 心率衍生（min / max / std）
        hrs = hr_per_day.get(d, [])
        if hrs:
            row["heart_rate_min"] = min(hrs)
            row["heart_rate_max"] = max(hrs)
            if len(hrs) > 1:
                m = sum(hrs) / len(hrs)
                row["heart_rate_std"] = (sum((x - m) ** 2 for x in hrs) / (len(hrs) - 1)) ** 0.5
            else:
                row["heart_rate_std"] = 0
            row["heart_rate_samples"] = len(hrs)
        else:
            row["heart_rate_min"] = row["heart_rate_max"] = row["heart_rate_std"] = None
            row["heart_rate_samples"] = 0

        # 睡眠：把各階段秒數轉小時，並算睡眠分數
        s = sleep_per_day.get(d, {})
        deep = s.get("AsleepDeep", 0) / 3600
        core = s.get("AsleepCore", 0) / 3600     # iOS 16+ 的「核心睡眠」≈ 淺眠
        rem  = s.get("AsleepREM", 0)  / 3600
        unspec = s.get("AsleepUnspecified", 0) / 3600  # 舊資料 / 第三方裝置
        awake = s.get("Awake", 0) / 3600
        in_bed = s.get("InBed", 0) / 3600

        asleep_total = deep + core + rem + unspec
        row["sleep_deep_h"]   = round(deep, 2)
        row["sleep_core_h"]   = round(core, 2)
        row["sleep_rem_h"]    = round(rem, 2)
        row["sleep_awake_h"]  = round(awake, 2)
        row["sleep_in_bed_h"] = round(in_bed, 2)
        row["sleep_total_h"]  = round(asleep_total, 2)

        # 自製睡眠分數 (0-100)：時長 50% + 深睡比 25% + REM 比 25%
        # 7.5h 為時長滿分基準；深睡 20%、REM 25% 為比例滿分基準
        if asleep_total >= 1:
            dur_score   = min(asleep_total / 7.5, 1) * 50
            deep_ratio  = deep / asleep_total
            rem_ratio   = rem  / asleep_total
            deep_score  = min(deep_ratio / 0.20, 1) * 25
            rem_score   = min(rem_ratio  / 0.25, 1) * 25
            row["sleep_score"] = round(dur_score + deep_score + rem_score, 1)
        else:
            row["sleep_score"] = None

        rows.append(row)

    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").reset_index(drop=True)

    # 補上缺失的日期（填空白列），讓時間軸連續
    if len(df) > 0:
        full_range = pd.date_range(df["date"].min(), df["date"].max(), freq="D")
        df = df.set_index("date").reindex(full_range).rename_axis("date").reset_index()

    # 加上方便分析的欄位
    df["weekday"] = df["date"].dt.day_name()
    df["is_weekend"] = df["date"].dt.weekday >= 5

    # 30 天滾動基線（用來判斷「今天 vs 個人基線」）
    for col in ["resting_hr", "hrv_sdnn_ms", "respiratory_rate", "sleep_score"]:
        if col in df.columns:
            df[f"{col}_baseline30"] = df[col].rolling(30, min_periods=7).mean()
            df[f"{col}_zscore30"] = (
                (df[col] - df[f"{col}_baseline30"]) /
                df[col].rolling(30, min_periods=7).std()
            )

    return df


def main():
    if len(sys.argv) < 3:
        print("用法: python parse_health.py <export.xml> <output_dir>")
        sys.exit(1)

    xml_path = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    if not xml_path.exists():
        print(f"找不到檔案: {xml_path}")
        sys.exit(1)

    quant, hr, sleep = parse_records(xml_path)
    df = build_dataframe(quant, hr, sleep)

    print("[3/3] 輸出檔案 ...")
    csv_path = out_dir / "health_daily.csv"
    parquet_path = out_dir / "health_daily.parquet"
    df.to_csv(csv_path, index=False)
    try:
        df.to_parquet(parquet_path, index=False)
        print(f"   ✓ {parquet_path}")
    except Exception as e:
        print(f"   (略過 parquet：{e})")
    print(f"   ✓ {csv_path}")

    # 簡短統計
    print("\n=== 摘要 ===")
    print(f"日期範圍：{df['date'].min().date()} → {df['date'].max().date()}（{len(df)} 天）")
    print(f"欄位數：{len(df.columns)}")
    print("\n各指標非空天數：")
    for col in df.columns:
        if col in ("date", "weekday", "is_weekend"):
            continue
        non_null = df[col].notna().sum()
        if non_null > 0:
            print(f"  {col:30s} {non_null:>5d} 天")


if __name__ == "__main__":
    main()
