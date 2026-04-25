# AutoHealth — Apple Health 跨維度分析儀表板

把 Apple Health 匯出的「太基礎」數據（睡眠、血氧、心跳、步數、HRV…）自動化成
可看趨勢、跨維度對照、找異常的儀表板。

## 功能

| 分頁 | 做什麼 |
|---|---|
| 🤖 自動洞察 | 中文總結最近 7 天 vs 21 天的明顯變化、顯著相關、異常事件 |
| 📈 趨勢 | 多指標疊加 + 滾動平均（視窗可調） |
| 🔗 相關矩陣 | 全指標 Spearman 相關（對離群值穩健） |
| ⏱ 延遲相關 | 例：今晚睡眠時數 → 隔天靜息心跳（lag = 1） |
| ⚠ 異常天 | 以前 28 天為基準，標出 ≥ 2σ 的異常 |
| 🧾 原始每日表 | 每日彙整可下載 CSV |

支援的 HealthKit 指標：步數、活動消耗、步行距離、爬樓層、心率、靜息心率、
步行心率、HRV (SDNN)、血氧、呼吸頻率、體溫、VO2 Max，以及睡眠分析（深睡 /
REM / 清醒分鐘、效率、就寢時點、睡眠期間最低血氧）。

## 安裝與啟動

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
streamlit run app.py
```

打開瀏覽器後在左側上傳 `匯出.zip`（內含 `export.xml`）即可。

## 取得 Apple Health 匯出檔

iPhone「**健康** App → 個人頭像 → 匯出所有健康資料**」會產生
`匯出.zip`，可以直接 AirDrop 到電腦上傳。

## 隱私

所有解析與分析都在本機完成，不會上傳任何資料。`.gitignore` 已排除
`export.xml` / `export.zip` / `data/` / `.cache/`。

## 結構

```
healthkit/
  parser.py      # 串流解析 export.xml（可吃幾百 MB）
  aggregator.py  # 各指標 → 每日聚合（含睡眠分段）
  analyzer.py    # 相關矩陣、延遲相關、異常偵測、洞察生成
app.py           # Streamlit UI
```

## 注意

僅供生活資料探索之用，**不能取代醫療診斷**。任何持續性異常請諮詢醫師。
