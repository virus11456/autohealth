"""
Apple Health export.xml → 每日寬表 (CSV + Parquet)

設計重點：
- 使用 SQLite 當暫存層，避免大檔案造成 OOM（實測 1.5 GB / 370 萬筆 也能跑）
- 串流解析，記憶體佔用恆定
- 自動處理中文匯出檔名 (輸出.xml) 與英文 (export.xml)
- 30 天滾動基線 + z-score，方便後續交叉分析

用法：
    python parse_health.py /path/to/export.xml /path/to/output_dir

例如：
    python parse_health.py ~/Downloads/apple_health_export/輸出.xml ./out
    python parse_health.py ~/Downloads/apple_health_export/export.xml ./out

需要套件：
    pip install pandas pyarrow
"""

import sys
import sqlite3
import xml.etree.ElementTree as ET
from pathlib import Path
from datetime import datetime
import pandas as pd

# ======================================================================
# 指標對應表
#   key   = Apple Health 的 type 字串
#   value = (輸出欄位名, 聚合方式: "mean" or "sum")
# ======================================================================
METRIC_MAP = {
    # ---- 心血管 / 自律神經 ----
    "HKQuantityTypeIdentifierHeartRate":                     ("heart_rate_mean",       "mean"),
    "HKQuantityTypeIdentifierHeartRateVariabilitySDNN":      ("hrv_sdnn_ms",           "mean"),
    "HKQuantityTypeIdentifierRestingHeartRate":              ("resting_hr",            "mean"),
    "HKQuantityTypeIdentifierWalkingHeartRateAverage":       ("walking_hr_avg",        "mean"),
    "HKQuantityTypeIdentifierVO2Max":                        ("vo2_max",               "mean"),
    "HKQuantityTypeIdentifierHeartRateRecoveryOneMinute":    ("hr_recovery_1min",      "mean"),

    # ---- 呼吸 / 血氧 / 體溫 ----
    "HKQuantityTypeIdentifierOxygenSaturation":              ("spo2_mean",             "mean"),
    "HKQuantityTypeIdentifierRespiratoryRate":               ("respiratory_rate",      "mean"),
    "HKQuantityTypeIdentifierAppleSleepingWristTemperature": ("wrist_temp_delta_c",    "mean"),

    # ---- 活動 / 步態 ----
    "HKQuantityTypeIdentifierStepCount":                     ("steps",                 "sum"),
    "HKQuantityTypeIdentifierDistanceWalkingRunning":        ("distance_km",           "sum"),
    "HKQuantityTypeIdentifierFlightsClimbed":                ("flights_climbed",       "sum"),
    "HKQuantityTypeIdentifierWalkingAsymmetryPercentage":    ("walking_asymmetry_pct", "mean"),
    "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage":("double_support_pct",    "mean"),
    "HKQuantityTypeIdentifierWalkingSpeed":                  ("walking_speed_mps",     "mean"),
    "HKQuantityTypeIdentifierWalkingStepLength":             ("step_length_cm",        "mean"),
    "HKQuantityTypeIdentifierAppleWalkingSteadiness":        ("walking_steadiness",    "mean"),
    "HKQuantityTypeIdentifierSixMinuteWalkTestDistance":     ("six_min_walk_m",        "mean"),

    # ---- 能量消耗 / 運動 ----
    "HKQuantityTypeIdentifierActiveEnergyBurned":            ("active_kcal",           "sum"),
    "HKQuantityTypeIdentifierBasalEnergyBurned":             ("basal_kcal",            "sum"),
    "HKQuantityTypeIdentifierAppleExerciseTime":             ("exercise_minutes",      "sum"),
    "HKQuantityTypeIdentifierAppleStandTime":                ("stand_minutes",         "sum"),

    # ---- 環境 ----
    "HKQuantityTypeIdentifierTimeInDaylight":                ("daylight_minutes",      "sum"),
    "HKQuantityTypeIdentifierHeadphoneAudioExposure":        ("headphone_db",          "mean"),
    "HKQuantityTypeIdentifierEnvironmentalAudioExposure":    ("env_audio_db",          "mean"),

    # ---- 身體組成 ----
    "HKQuantityTypeIdentifierBodyMass":                      ("body_mass_kg",          "mean"),
    "HKQuantityTypeIdentifierBodyMassIndex":                 ("bmi",                   "mean"),
}

SLEEP_TYPE = "HKCategoryTypeIdentifierSleepAnalysis"
HR_TYPE = "HKQuantityTypeIdentifierHeartRate"


# ======================================================================
# Pass 1: 串流解析 → SQLite
# ======================================================================
def parse_to_sqlite(xml_path: Path, db_path: Path):
    print(f"[1/4] 解析 {xml_path}")
    print(f"      檔案大小: {xml_path.stat().st_size / (1024**3):.2f} GB")

    if db_path.exists():
        db_path.unlink()

    conn = sqlite3.connect(str(db_path))
    # 提升寫入效能
    conn.execute("PRAGMA journal_mode = OFF")
    conn.execute("PRAGMA synchronous = OFF")
    conn.execute("""
        CREATE TABLE quant (
            type TEXT, date TEXT, value REAL
        )
    """)
    conn.execute("""
        CREATE TABLE sleep (
            date TEXT, stage TEXT,
            start_ts TEXT, end_ts TEXT, duration_s REAL
        )
    """)

    interest = set(METRIC_MAP.keys())

    quant_batch = []
    sleep_batch = []
    total = 0
    kept_q = 0
    kept_s = 0

    for event, elem in ET.iterparse(str(xml_path), events=("end",)):
        if elem.tag != "Record":
            elem.clear()
            continue

        rtype = elem.get("type")
        start = elem.get("startDate") or ""
        if not start or len(start) < 19:
            elem.clear()
            total += 1
            continue

        date_key = start[:10]

        if rtype in interest:
            v = elem.get("value")
            try:
                vf = float(v) if v is not None else None
                if vf is not None:
                    quant_batch.append((rtype, date_key, vf))
                    kept_q += 1
            except (TypeError, ValueError):
                pass

        elif rtype == SLEEP_TYPE:
            end_d = elem.get("endDate") or ""
            value = elem.get("value") or ""
            if len(end_d) >= 19:
                try:
                    dt_s = datetime.strptime(start[:19], "%Y-%m-%d %H:%M:%S")
                    dt_e = datetime.strptime(end_d[:19], "%Y-%m-%d %H:%M:%S")
                    duration_s = (dt_e - dt_s).total_seconds()
                    sleep_date = end_d[:10]   # 歸到醒來那天
                    stage = value.replace("HKCategoryValueSleepAnalysis", "")
                    sleep_batch.append((sleep_date, stage, start[:19], end_d[:19], duration_s))
                    kept_s += 1
                except Exception:
                    pass

        if len(quant_batch) >= 10_000:
            conn.executemany("INSERT INTO quant VALUES (?,?,?)", quant_batch)
            quant_batch.clear()
        if len(sleep_batch) >= 5_000:
            conn.executemany("INSERT INTO sleep VALUES (?,?,?,?,?)", sleep_batch)
            sleep_batch.clear()

        total += 1
        if total % 500_000 == 0:
            print(f"      已處理 {total:,} 筆 record (保留 quant={kept_q:,}, sleep={kept_s:,})")

        elem.clear()

    if quant_batch:
        conn.executemany("INSERT INTO quant VALUES (?,?,?)", quant_batch)
    if sleep_batch:
        conn.executemany("INSERT INTO sleep VALUES (?,?,?,?,?)", sleep_batch)
    conn.commit()

    print(f"      共處理 {total:,} 筆 record")
    print(f"      保留 quant={kept_q:,}, sleep={kept_s:,}")

    print("      建立索引...")
    conn.execute("CREATE INDEX idx_q ON quant(type, date)")
    conn.execute("CREATE INDEX idx_s ON sleep(date)")
    conn.commit()
    conn.close()


# ======================================================================
# Pass 2: SQL 聚合 → DataFrame
# ======================================================================
def build_dataframe(db_path: Path) -> pd.DataFrame:
    print("[2/4] SQL 聚合每日指標")
    conn = sqlite3.connect(str(db_path))

    # ----- 數值指標 -----
    frames = []
    for rtype, (col, agg) in METRIC_MAP.items():
        sql_agg = "AVG(value)" if agg == "mean" else "SUM(value)"
        sql = f"""
            SELECT date, {sql_agg} AS v
            FROM quant
            WHERE type = ?
            GROUP BY date
        """
        df_m = pd.read_sql(sql, conn, params=[rtype])
        if not df_m.empty:
            df_m = df_m.rename(columns={"v": col})
            df_m["date"] = pd.to_datetime(df_m["date"])
            frames.append(df_m.set_index("date"))

    df = pd.concat(frames, axis=1) if frames else pd.DataFrame()

    # ----- 心率衍生 (min / max / std / 樣本數) -----
    hr_df = pd.read_sql(
        f"""
        SELECT date,
               MIN(value)   AS heart_rate_min,
               MAX(value)   AS heart_rate_max,
               COUNT(*)     AS heart_rate_samples
        FROM quant
        WHERE type = '{HR_TYPE}'
        GROUP BY date
        """, conn
    )
    if not hr_df.empty:
        hr_df["date"] = pd.to_datetime(hr_df["date"])
        df = df.join(hr_df.set_index("date"), how="outer")

    # 心率 std 用 pandas 算（SQLite 沒原生 stdev）
    print("      計算心率 std...")
    hr_std = pd.read_sql(
        f"SELECT date, value FROM quant WHERE type = '{HR_TYPE}'",
        conn
    )
    if not hr_std.empty:
        hr_std["date"] = pd.to_datetime(hr_std["date"])
        std_per_day = hr_std.groupby("date")["value"].std().rename("heart_rate_std")
        df = df.join(std_per_day, how="outer")

    # ----- 睡眠 -----
    print("      聚合睡眠階段...")
    sleep_df = pd.read_sql(
        """
        SELECT date, stage, SUM(duration_s) AS dur
        FROM sleep
        GROUP BY date, stage
        """, conn
    )
    if not sleep_df.empty:
        sleep_pivot = sleep_df.pivot(index="date", columns="stage", values="dur").fillna(0)
        sleep_pivot.index = pd.to_datetime(sleep_pivot.index)

        # 各階段轉小時
        deep   = sleep_pivot.get("AsleepDeep",        pd.Series(0, index=sleep_pivot.index)) / 3600
        core   = sleep_pivot.get("AsleepCore",        pd.Series(0, index=sleep_pivot.index)) / 3600
        rem    = sleep_pivot.get("AsleepREM",         pd.Series(0, index=sleep_pivot.index)) / 3600
        unspec = sleep_pivot.get("AsleepUnspecified", pd.Series(0, index=sleep_pivot.index)) / 3600
        awake  = sleep_pivot.get("Awake",             pd.Series(0, index=sleep_pivot.index)) / 3600
        in_bed = sleep_pivot.get("InBed",             pd.Series(0, index=sleep_pivot.index)) / 3600

        asleep_total = deep + core + rem + unspec

        sleep_summary = pd.DataFrame({
            "sleep_deep_h":   deep.round(2),
            "sleep_core_h":   core.round(2),
            "sleep_rem_h":    rem.round(2),
            "sleep_awake_h":  awake.round(2),
            "sleep_in_bed_h": in_bed.round(2),
            "sleep_total_h":  asleep_total.round(2),
        })

        # 睡眠分數 (0-100): 時長 50% + 深睡比 25% + REM 比 25%
        score = pd.Series(index=asleep_total.index, dtype=float)
        mask = asleep_total >= 1
        if mask.any():
            dur_score  = (asleep_total[mask].clip(upper=7.5) / 7.5) * 50
            deep_ratio = deep[mask] / asleep_total[mask]
            rem_ratio  = rem[mask]  / asleep_total[mask]
            deep_score = (deep_ratio.clip(upper=0.20) / 0.20) * 25
            rem_score  = (rem_ratio.clip(upper=0.25)  / 0.25) * 25
            score.loc[mask] = (dur_score + deep_score + rem_score).round(1)
        sleep_summary["sleep_score"] = score

        df = df.join(sleep_summary, how="outer")

    # ----- 上床 / 起床時間 -----
    print("      計算上床/起床時間...")
    bed_df = pd.read_sql(
        """
        SELECT date,
               MIN(start_ts) AS bedtime,
               MAX(end_ts)   AS wake_time
        FROM sleep
        WHERE stage LIKE 'Asleep%'
        GROUP BY date
        """, conn
    )
    if not bed_df.empty:
        bed_df["date"] = pd.to_datetime(bed_df["date"])
        # bedtime_hour: 23:30 → 23.5、01:30 → 25.5（方便看作息漂移）
        def hour_of(ts):
            try:
                t = datetime.strptime(ts[:19], "%Y-%m-%d %H:%M:%S")
                h = t.hour + t.minute / 60
                return h + 24 if h < 12 else h
            except Exception:
                return None
        bed_df["bedtime_hour"] = bed_df["bedtime"].apply(hour_of).round(2)
        df = df.join(bed_df.set_index("date"), how="outer")

    conn.close()

    # ----- 後處理 -----
    df = df.sort_index().reset_index().rename(columns={"index": "date"})

    # 補齊缺失日期讓時間軸連續
    if len(df) > 0:
        full_range = pd.date_range(df["date"].min(), df["date"].max(), freq="D")
        df = df.set_index("date").reindex(full_range).rename_axis("date").reset_index()

    df["weekday"]    = df["date"].dt.day_name()
    df["is_weekend"] = df["date"].dt.weekday >= 5

    # 30 天滾動基線 + z-score
    print("[3/4] 計算 30 天滾動基線與 z-score")
    baseline_cols = [
        "resting_hr", "hrv_sdnn_ms", "respiratory_rate",
        "sleep_score", "wrist_temp_delta_c", "walking_hr_avg",
    ]
    for col in baseline_cols:
        if col in df.columns:
            mean30 = df[col].rolling(30, min_periods=7).mean()
            std30  = df[col].rolling(30, min_periods=7).std()
            df[f"{col}_baseline30"] = mean30.round(2)
            df[f"{col}_zscore30"]   = ((df[col] - mean30) / std30).round(2)

    return df


# ======================================================================
# main
# ======================================================================
def main():
    if len(sys.argv) < 3:
        print("用法: python parse_health.py <export.xml> <output_dir>")
        sys.exit(1)

    xml_path = Path(sys.argv[1])
    out_dir  = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    if not xml_path.exists():
        print(f"找不到檔案: {xml_path}")
        sys.exit(1)

    db_path = out_dir / "_health_raw.db"

    parse_to_sqlite(xml_path, db_path)
    df = build_dataframe(db_path)

    print("[4/4] 輸出檔案")
    csv_path     = out_dir / "health_daily.csv"
    parquet_path = out_dir / "health_daily.parquet"
    df.to_csv(csv_path, index=False)
    print(f"      ✓ {csv_path}")
    try:
        df.to_parquet(parquet_path, index=False)
        print(f"      ✓ {parquet_path}")
    except Exception as e:
        print(f"      (略過 parquet：{e})")

    # 預設保留 SQLite 暫存檔（要重跑分析很方便）
    # 不需要的話可以手動刪除
    print(f"      暫存 SQLite: {db_path} (可保留供後續查詢, 不需要可刪除)")

    # 摘要
    print("\n" + "=" * 64)
    print("摘要")
    print("=" * 64)
    print(f"日期範圍: {df['date'].min().date()} → {df['date'].max().date()}（{len(df)} 天）")
    print(f"總欄位數: {len(df.columns)}")
    print("\n各指標非空天數:")
    skip = {"date", "weekday", "is_weekend", "bedtime", "wake_time"}
    for col in df.columns:
        if col in skip or col.endswith(("_baseline30", "_zscore30")):
            continue
        n = df[col].notna().sum()
        if n > 0:
            print(f"  {col:<28s} {n:>5d} 天")


if __name__ == "__main__":
    main()
