# AutoHealth — Apple Health 跨維度分析儀表板

把 Apple Health 匯出的「太基礎」數據（睡眠、血氧、心跳、HRV、步態、日照、
手腕體溫…）自動化成 7 個可一眼看懂的健康分析分頁，**外加 MiniMax AI 聊天
助手** 直接回答你關於自己資料的問題。

## 7 個分頁

| 分頁 | 回答的問題 | 主要視覺 |
|---|---|---|
| 🔋 2 三角 | 我目前心跳、放鬆度、體能怎樣？最近會不會生病？ | 3 張 metric 卡 + 三合一線圖 + 可能影響卡 |
| 💤 3 睡眠 | 哪一個睡眠面向最影響我隔天的精神？ | 3 張影響力卡 + 行動建議 + 分箱 boxplot |
| 🚶 4 步態 | 走路品質有沒有偷偷退化？訓練量大時會不會代償？ | 5 張步態卡 + 走多 vs 走少對比 |
| 🌅 5 節律 | 日照夠嗎？作息穩不穩？週末有沒有恢復到？ | 4 張卡 + 月度作息穩定度 + 日照分箱 |
| ✅ 6 Readiness | 今天身體準備好了嗎？可以硬操嗎？ | 大數字 hero + 365 天走勢 + 拆解表 |
| 🤒 7 早警 | 今天有沒有發病前兆？最近過勞了嗎？ | 結論面板 + 影響卡 + 14 天概覽 |
| ✨ AI 解讀 | **任何問題** | 多輪聊天 + 一次性摘要 / 深度報告 |

每個分頁固定結構：

1. **頂部結論面板**（綠/藍/黃/紅）— 三秒看懂今天狀態 + 一句行動
2. **影響卡列表** — 白話解釋偏離的指標對身體的可能影響
3. **必要圖表** — 每張 metric 卡都有連線圖 + 個人平均虛線（直接看「比平常高還是低」）
4. **「想看數字」摺疊區** — 把 t-test、相關矩陣這類技術細節收起來

「📋 資料健檢」（涵蓋率、密度斷層、離群值、黃金窗口）放在右上 ⚙ 設定面板裡，
不佔分頁。

## ✨ MiniMax AI 聊天助手

設定 token 後（右上 ⚙），AI 解讀分頁就是一個 chatbot：

- AI 直接看到你最近 30 天的健康指標 + 今日 Readiness / Env Stress 快照
- 多輪對話，可以追問
- 預設問題建議：「最近會不會生病？」「我該怎麼睡得更好？」「為什麼我最近這麼累？」
- 另外保留「✨ 每日輕量摘要」「🔬 深度分析（7 任務）」的一次性報告選項

支援端點：
- 中國版 MiniMax: `https://api.minimaxi.com/v1`
- 國際版 MiniMax: `https://api.minimax.io/v1`
- Model: `MiniMax-M2.7` 或 `MiniMax-M2.7-highspeed`

## 支援的 HealthKit 指標（25 個）

**心血管 / 自律神經**：心率、HRV (SDNN)、靜息心率、步行心率、VO2 Max、1 分鐘心率恢復
**呼吸 / 血氧 / 體溫**：血氧、呼吸頻率、睡眠手腕溫差（Series 8+）
**步態**：步行不對稱率、雙腳支撐時間、步行速度、步長、步行穩定度、6 分鐘步行距離
**活動 / 能量**：步數、步行距離、爬樓層、活動消耗、基礎代謝、運動時間、站立時間
**環境**：日照時間、耳機 / 環境音量
**身體組成**：體重、BMI
**睡眠**：深睡 / REM / 核心睡眠 / 清醒 分鐘、就寢時點、睡眠效率、睡眠期間最低血氧、自製睡眠分數

加 30 天滾動 baseline 與 z-score 衍生欄位，以及自製的 **Readiness Score** 與
**Environment Stress Score**。

## 兩種使用方式

### A. 純瀏覽器版（推薦）— GitHub Pages

`docs/` 內是純 HTML/JS 版本，所有解析在你的瀏覽器內進行，**資料不離開電腦**。
部署到 GitHub Pages：

1. Repo Settings → Pages
2. Source: Deploy from a branch
3. Branch: 你目前的開發分支，Folder: `/docs`
4. 等 1–2 分鐘，`https://<user>.github.io/autohealth/` 即可使用

> 本機跑：`cd docs && python3 -m http.server`，瀏覽器開
> `http://localhost:8000`。**不要直接雙擊 index.html**，
> ES module 在 `file://` 下會被擋。

### B. Python 版（本機 Streamlit）

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
streamlit run app.py
```

左側上傳 `匯出.zip`（內含 `export.xml`）即可。Streamlit 版的 AI 走伺服器端，
沒有瀏覽器跨域問題，CN 版 MiniMax 用這個最穩。

### C. 大檔離線分析 CLI

如果你的 export 很大（>1 GB / 數百萬筆 record），用 `scripts/parse_health.py`：

```bash
python scripts/parse_health.py /path/to/export.xml ./out
```

SQLite 暫存避免 OOM，產出 `health_daily.csv` 與 `health_daily.parquet`。
適合配合 Claude Code / Jupyter 做客製化分析。

## 取得 Apple Health 匯出檔

iPhone「**健康** App → 個人頭像 → 匯出所有健康資料」會產生 `匯出.zip`，
AirDrop 到電腦即可上傳。

## 隱私

所有解析與分析都在本機完成。`.gitignore` 已排除 `export.xml` / `export.zip` /
`data/` / `.cache/`。

**唯一例外**：若你貼上 MiniMax token 並啟用 AI 解讀（聊天 / 摘要 / 深度分析），
那次的健康資料摘要會送到你選的 LLM 服務商（預設 MiniMax）。token 只存在你
瀏覽器的 `localStorage`（前端版）或 Streamlit session 記憶體（Python 版），
**不會寫進 git、不會送到任何中間伺服器**。AI 功能完全選用，不啟用就跟原本一樣
資料只在本機。

## 結構

```
docs/                # 純前端版（GitHub Pages 部署目標）
  index.html
  app.js             # UI 與分頁互動
  parser.js          # 瀏覽器內串流 XML / ZIP 解析
  aggregator.js      # 每日聚合 + 30 天 baseline / z-score
  analyzer.js        # Spearman / 延遲相關 / 異常 / Readiness / Env Stress
  tasks.js           # 7 個分析任務的 render 邏輯
  ai.js              # MiniMax client + chat / 摘要 / 深度 prompt 建構
  styles.css

healthkit/           # Python 版（Streamlit）
  parser.py          # 串流解析 export.xml（可吃幾百 MB）
  aggregator.py      # 每日聚合（含睡眠分段、HR 衍生）
  analyzer.py        # 相關矩陣、延遲相關、異常偵測、洞察、Readiness
app.py               # Streamlit UI（含 sidebar AI 設定 + ✨ AI 解讀分頁）

scripts/
  parse_health.py        # 大檔 CLI 解析（SQLite buffered）
  make_sample_export.py  # 產合成 export 用於測試
  smoke_test.py / .mjs   # Python / JS 端對端測試
  qa_test.mjs            # 7 任務 render 自動測試
```

## 開發者 / QA 工具

```bash
# 產合成 sample export
python scripts/make_sample_export.py

# 跑 Python pipeline 端對端
python scripts/smoke_test.py

# 跑 JS pipeline 端對端
node scripts/smoke_test.mjs

# 7 任務 render 自動 QA（empty/short/missing-cols/leak detection）
node scripts/qa_test.mjs
```

## 注意

僅供生活資料探索之用，**不能取代醫療診斷**。任何持續性異常請諮詢醫師。
