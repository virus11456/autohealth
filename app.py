"""AutoHealth — Apple Health 跨維度分析儀表板.

Run with: streamlit run app.py
Upload your Apple Health export.zip (匯出於 健康 App > 個人頭像 > 匯出所有健康資料).
"""
from __future__ import annotations

import io
from datetime import timedelta
from pathlib import Path

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st

from healthkit import (
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
from healthkit.analyzer import METRIC_LABELS_ZH


st.set_page_config(page_title="AutoHealth 儀表板", page_icon="❤", layout="wide")

CACHE_DIR = Path(".cache")
CACHE_DIR.mkdir(exist_ok=True)


@st.cache_data(show_spinner=False)
def _load(file_bytes: bytes, name: str) -> dict[str, pd.DataFrame]:
    bio = io.BytesIO(file_bytes)
    bio.name = name
    return parse_export(bio)


@st.cache_data(show_spinner=False)
def _daily(per_metric: dict[str, pd.DataFrame]) -> pd.DataFrame:
    return build_daily_frame(per_metric)


def _label(col: str) -> str:
    return METRIC_LABELS_ZH.get(col, col)


def _severity_color(sev: str) -> str:
    return {"info": "#3b82f6", "watch": "#f59e0b", "alert": "#ef4444"}.get(sev, "#6b7280")


# ------------------------- sidebar / data loading -------------------------
st.sidebar.title("📥 資料來源")
st.sidebar.markdown(
    "1. 在 iPhone「**健康** > 個人頭像 > 匯出所有健康資料**」  \n"
    "2. 取得 `匯出.zip`（內含 `export.xml`）  \n"
    "3. 在下方上傳即可"
)
uploaded = st.sidebar.file_uploader("上傳 export.zip 或 export.xml", type=["zip", "xml"])

if "per_metric" not in st.session_state:
    st.session_state.per_metric = None

if uploaded is not None:
    with st.spinner("解析中… 大檔案可能要 30 秒到數分鐘"):
        try:
            st.session_state.per_metric = _load(uploaded.getvalue(), uploaded.name)
        except Exception as exc:
            st.sidebar.error(f"解析失敗: {exc}")

per_metric = st.session_state.per_metric
if per_metric is None:
    st.title("❤ AutoHealth — Apple Health 跨維度分析儀表板")
    st.markdown(
        """
        ### 功能
        - **每日摘要 + 滾動平均**：把睡眠、血氧、心跳、步數、HRV 等基礎資料聚合成每日值。
        - **跨維度比對**：自動算 Spearman 相關（含時間延遲），找出像「睡眠時數 → 隔天靜息心跳」這種關聯。
        - **異常天偵測**：以前 28 天為基準，標記 ≥ 2σ 的異常值。
        - **自動洞察**：用中文總結最近 7 天 vs 21 天的趨勢變化、顯著相關、異常事件。

        ### 使用步驟
        左側上傳 Apple Health 的 `匯出.zip` 即可開始。
        """
    )
    st.stop()

daily = _daily(per_metric)
if daily.empty:
    st.warning("解析完成但沒有可分析的資料。請確認你的 Apple Health 是否有睡眠/心跳/血氧/步數等紀錄。")
    st.stop()

# ------------------------- header / filters -------------------------
st.title("❤ AutoHealth 跨維度分析")
min_date, max_date = daily.index.min().date(), daily.index.max().date()

c1, c2, c3 = st.columns([2, 2, 1])
with c1:
    date_range = st.date_input(
        "分析期間",
        value=(max(min_date, max_date - timedelta(days=180)), max_date),
        min_value=min_date,
        max_value=max_date,
    )
with c2:
    window = st.slider("滾動平均視窗 (天)", 3, 30, 7)
with c3:
    sigma = st.slider("異常 σ 閾值", 1.5, 4.0, 2.0, 0.5)

if isinstance(date_range, tuple) and len(date_range) == 2:
    start, end = pd.Timestamp(date_range[0]), pd.Timestamp(date_range[1])
    df = daily.loc[start:end].copy()
else:
    df = daily.copy()

if df.empty:
    st.info("選定區間沒有資料。")
    st.stop()

# Phase 3 composite scores — computed against the full daily frame so the
# 30-day baselines that feed the z-score columns aren't truncated by the
# date filter, then sliced to the visible window.
readiness_full = compute_readiness(daily)
env_stress_full = compute_env_stress(daily)
df["readiness"] = readiness_full.reindex(df.index)
df["env_stress"] = env_stress_full.reindex(df.index)

# ------------------------- Phase 3 score banner -------------------------
def _score_band(score: float) -> tuple[str, str]:
    """Map 0-100 to (label, color)."""
    if not pd.notna(score):
        return "—", "#6b7280"
    if score >= 70:
        return "良好", "#10b981"
    if score >= 50:
        return "尚可", "#3b82f6"
    if score >= 30:
        return "偏低", "#f59e0b"
    return "警戒", "#ef4444"


def _latest_score(col: str) -> float:
    if col not in df.columns:
        return float("nan")
    s = df[col].dropna()
    return float(s.iloc[-1]) if not s.empty else float("nan")


readiness_today = _latest_score("readiness")
env_today = _latest_score("env_stress")
score_cols = st.columns([1, 1])
for col_ui, (col_name, label, hint) in zip(
    score_cols,
    (
        ("readiness", "🌿 恢復分數", "HRV ↑ + 靜息心率 ↓ + 睡眠分數 + 呼吸頻率穩定的綜合 0-100 分"),
        ("env_stress", "🌫 環境壓力", "日照不足 + 血氧偏低 + 呼吸頻率偏高 + HRV 偏低（高 = 警訊）"),
    ),
):
    val = _latest_score(col_name)
    band_label, band_color = _score_band(val if col_name == "readiness" else (100 - val) if pd.notna(val) else val)
    val_text = f"{val:.0f}" if pd.notna(val) else "—"
    with col_ui:
        st.markdown(
            f"""
            <div style="border-left:6px solid {band_color}; padding:12px 16px;
                        background:rgba(127,127,127,0.06); border-radius:6px;">
              <div style="font-size:0.85em; opacity:0.7;">{label}</div>
              <div style="font-size:2em; font-weight:600; color:{band_color};">{val_text}
                <span style="font-size:0.5em; opacity:0.7;"> / 100 · {band_label}</span></div>
              <div style="font-size:0.8em; opacity:0.7;">{hint}</div>
            </div>
            """,
            unsafe_allow_html=True,
        )

# ------------------------- KPI strip -------------------------
def _kpi(label: str, col: str, fmt: str = "{:.1f}", suffix: str = ""):
    if col not in df.columns or df[col].dropna().empty:
        st.metric(label, "—")
        return
    series = df[col].dropna()
    recent = series.tail(7).mean()
    prior = series.tail(28).head(21).mean() if len(series) > 28 else series.mean()
    delta = recent - prior if pd.notna(prior) else None
    st.metric(
        label,
        fmt.format(recent) + suffix,
        delta=(f"{delta:+.2f}" if delta is not None and pd.notna(delta) else None),
    )


k1, k2, k3, k4, k5, k6 = st.columns(6)
with k1: _kpi("睡眠分數 (近 7 天均)", "sleep_score", "{:.0f}", " /100")
with k2: _kpi("靜息心率", "resting_hr", "{:.0f}", " bpm")
with k3: _kpi("HRV", "hrv", "{:.0f}", " ms")
with k4: _kpi("血氧 (日均)", "spo2", "{:.1f}", " %")
with k5: _kpi("步數", "steps", "{:.0f}")
with k6: _kpi("日照", "daylight", "{:.0f}", " 分")

# ------------------------- tabs -------------------------
tab_insight, tab_trend, tab_corr, tab_lag, tab_anom, tab_data = st.tabs(
    ["🤖 自動洞察", "📈 趨勢", "🔗 相關矩陣", "⏱ 延遲相關", "⚠ 異常天", "🧾 原始每日表"]
)

# ---- insights ----
with tab_insight:
    st.subheader("最近的身體訊號")
    insights = generate_insights(df)
    if not insights:
        st.info("目前沒有足夠資料產生洞察（建議至少 4 週紀錄）。")
    else:
        for ins in insights:
            color = _severity_color(ins.severity)
            st.markdown(
                f"""
                <div style="border-left:4px solid {color}; padding:8px 12px; margin:6px 0;
                            background:rgba(127,127,127,0.06); border-radius:4px;">
                  <div style="font-weight:600;">{ins.title}</div>
                  <div style="opacity:0.8; font-size:0.9em;">{ins.detail}</div>
                </div>
                """,
                unsafe_allow_html=True,
            )

# ---- trends ----
with tab_trend:
    metric_options = [
        c for c in df.columns
        if c not in ("sleep_start", "sleep_end")
        and not c.endswith("_baseline30") and not c.endswith("_zscore30")
        and df[c].notna().sum() > 0
    ]
    default = [m for m in ("readiness", "hrv", "resting_hr", "sleep_score") if m in metric_options][:3]
    chosen = st.multiselect(
        "選擇要對照的指標",
        options=metric_options,
        default=default,
        format_func=_label,
    )
    if not chosen:
        st.info("請至少選一個指標。")
    else:
        smoothed = rolling_view(df[chosen], window=window)
        fig = go.Figure()
        for col in chosen:
            fig.add_trace(go.Scatter(
                x=df.index, y=df[col], name=f"{_label(col)} (原始)",
                mode="markers", marker=dict(size=4, opacity=0.35),
                legendgroup=col, showlegend=False,
            ))
            fig.add_trace(go.Scatter(
                x=smoothed.index, y=smoothed[col],
                name=f"{_label(col)} ({window} 天均)",
                mode="lines", line=dict(width=2.5),
                legendgroup=col,
            ))
        fig.update_layout(
            height=480, margin=dict(l=10, r=10, t=30, b=10),
            hovermode="x unified", legend=dict(orientation="h", y=-0.15),
        )
        st.plotly_chart(fig, use_container_width=True)

        st.caption("提示：把不同維度疊在一張圖上時，y 軸是共用的；想看單位差異大的指標關聯時，請使用「相關矩陣」或「延遲相關」分頁。")

# ---- correlation matrix ----
with tab_corr:
    st.subheader("Spearman 相關矩陣")
    st.caption("使用 Spearman（順序統計），對非線性與離群值較穩健。淺色 = 弱相關。")
    corr = correlation_matrix(df)
    if corr.empty:
        st.info("樣本不足以計算相關矩陣。")
    else:
        labelled = corr.rename(index=_label, columns=_label)
        fig = px.imshow(
            labelled, color_continuous_scale="RdBu_r", zmin=-1, zmax=1,
            aspect="auto", text_auto=".2f",
        )
        fig.update_layout(height=600, margin=dict(l=10, r=10, t=30, b=10))
        st.plotly_chart(fig, use_container_width=True)

# ---- lagged correlations ----
with tab_lag:
    st.subheader("時間延遲相關（找出『今天的行為 → 明天的身體反應』）")
    cols = [
        c for c in df.columns
        if df[c].notna().sum() >= 14
        and c not in ("sleep_start", "sleep_end")
        and not c.endswith("_baseline30") and not c.endswith("_zscore30")
    ]
    c1, c2 = st.columns(2)
    with c1:
        drivers = st.multiselect(
            "驅動因子（行為類）",
            options=cols,
            default=[c for c in ("sleep_hours", "steps", "active_energy", "bedtime_offset_min", "sleep_efficiency") if c in cols],
            format_func=_label,
        )
    with c2:
        responses = st.multiselect(
            "反應因子（身體狀態）",
            options=cols,
            default=[c for c in ("resting_hr", "hrv", "spo2", "spo2_sleep_min", "sleep_efficiency") if c in cols],
            format_func=_label,
        )
    lags = st.select_slider("檢視 lag 天數範圍", options=list(range(-3, 4)), value=(-1, 2))
    lag_range = tuple(range(lags[0], lags[1] + 1))

    if drivers and responses:
        lc = lagged_correlations(df, drivers, responses, lags=lag_range)
        if lc.empty:
            st.info("沒有足夠樣本。")
        else:
            display = lc.copy()
            display["驅動"] = display["driver"].map(_label)
            display["反應"] = display["response"].map(_label)
            display = display.rename(columns={
                "lag_days": "延遲 (天)", "spearman_r": "相關 r",
                "p_value": "p", "n": "天數",
            })[["驅動", "反應", "延遲 (天)", "相關 r", "p", "天數"]]
            st.dataframe(
                display.style
                    .background_gradient(subset=["相關 r"], cmap="RdBu_r", vmin=-1, vmax=1)
                    .format({"相關 r": "{:+.2f}", "p": "{:.3f}"}),
                use_container_width=True, height=420,
            )
            st.caption("延遲為正 = 反應在驅動之後 N 天測得；例如 sleep_hours → resting_hr (lag=1) 代表『今晚睡多少 vs 隔天靜息心跳』。")

# ---- anomalies ----
with tab_anom:
    st.subheader(f"異常天（≥ {sigma:.1f}σ vs 前 28 天）")
    anom = detect_anomalies(df, sigma=sigma)
    if anom.empty:
        st.success("近期沒有顯著異常。")
    else:
        anom_view = anom.copy()
        anom_view["指標"] = anom_view["metric"].map(_label)
        anom_view = anom_view.rename(columns={
            "date": "日期", "value": "當日值",
            "baseline_mean": "基準均值", "z_score": "Z 分數",
        })[["日期", "指標", "當日值", "基準均值", "Z 分數"]]
        st.dataframe(
            anom_view.style.format({
                "當日值": "{:.2f}", "基準均值": "{:.2f}", "Z 分數": "{:+.2f}"
            }),
            use_container_width=True, height=420,
        )

# ---- raw data ----
with tab_data:
    st.subheader("每日彙整資料")
    include_derived = st.checkbox(
        "顯示衍生欄位（30 天基線 / Z 分數）", value=False,
        help="這些欄位是 Phase 3 恢復分數的輸入，平常顯示會讓表變很寬。",
    )
    show = df.copy()
    if not include_derived:
        show = show[[c for c in show.columns
                     if not c.endswith("_baseline30") and not c.endswith("_zscore30")]]
    show.columns = [_label(c) for c in show.columns]
    st.dataframe(show, use_container_width=True, height=520)
    st.download_button(
        "下載 CSV",
        data=show.to_csv().encode("utf-8-sig"),
        file_name="autohealth_daily.csv",
        mime="text/csv",
    )

st.caption("⚠ 本工具僅作生活資料探索之用，不能取代醫療診斷。任何持續性異常請諮詢醫師。")
