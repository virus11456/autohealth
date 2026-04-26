# AutoHealth — Apple Health 跨維度分析儀表板

把 Apple Health 匯出的「太基礎」數據（睡眠、血氧、心跳、HRV、步態、日照、
手腕體溫…）自動化成 7 個**白話、阿嬤都看得懂**的健康分析分頁，**外加
MiniMax AI 聊天助手**直接回答你關於自己資料的問題。

> ⚙ 全部解析在你瀏覽器內進行，**資料不離開你的電腦**。

## 上方常駐：8 張平均指標卡

不論在哪個分頁都看得到的「分析期間平均」卡列：心率、靜息心率、血氧、HRV、
睡眠時數、心適能、呼吸、日照。每張卡顯示：

- 你目前期間的**平均值**
- **狀態徽章** ✓ 正常 / ↑ 偏高 / ↓ 偏低 / ⚠ 太高 / ⚠ 太低
- **正常範圍**（一般成人標準 — 設定年齡 / 性別後會切換成「30 歲男標準」這種）
- **異常時的注意事項**（例：「平均心率 96 bpm ↑ 偏高 → 壓力大 / 缺水 / 咖啡因過多 / 發炎前期」）

## 7 個分頁

| 分頁 | 回答的問題 | 主要視覺 |
|---|---|---|
| 🔋 2 三角 | 我目前心跳、放鬆度、體能怎樣？最近會不會生病？ | 3 張 metric 卡 + 三合一線圖 + 可能影響卡 + 7 天生病警訊 |
| 💤 3 睡眠 | 哪一個睡眠面向最影響我隔天的精神？ | 3 張影響力卡 + 行動建議 + 分箱長條圖 |
| 🚶 4 步態 | 走路品質有沒有偷偷退化？訓練量大時會不會代償？ | 5 張步態卡 + 走多 vs 走少對比 |
| 🌅 5 節律 | 日照夠嗎？作息穩不穩？週末有沒有恢復到？ | 4 張卡 + 月度作息穩定度 + 日照分箱長條 |
| ✅ 6 Readiness | 今天身體準備好了嗎？可以硬操嗎？ | 大數字 hero + 365 天走勢 + 拆解表 |
| 🤒 7 早警 | 今天有沒有發病前兆？最近過勞了嗎？ | 結論面板 + 影響卡 + 14 天概覽 |
| ✨ AI 解讀 | **任何問題** | 多輪聊天 + 一次性摘要 / 深度報告 |

每個分頁固定結構：

1. **頂部結論面板**（綠/藍/黃/紅）— 三秒看懂今天狀態 + 一句行動
2. **影響卡列表** — 白話解釋偏離的指標對身體的可能影響（例：「⚠ HRV 比平常低
   → 身體在緊繃狀態，恢復力下降。可能會比較煩躁、容易煩、做決定可能衝動」）
3. **必要圖表** — 每張 metric 卡都有連線圖 + 個人平均虛線（直接看「比平常高還是低」）
4. **「想看數字」摺疊區** — 把 t-test、相關矩陣這類技術細節收起來

「📋 資料健檢」（涵蓋率、密度斷層、離群值、黃金窗口）放在右上 ⚙ 設定面板裡，
不佔分頁。

## ⚙ 個人設定（可選）

右上齒輪打開：

- **👤 年齡 / 生理性別**：HRV、心適能（VO2 Max）有強烈年齡與性別差異，填了之後
  vitals 卡會顯示對應你年齡標準的範圍（例：「35歲男 38–54 ml/kg·min」），不再是
  泛用成人範圍
- **🤖 MiniMax AI**：token / endpoint / model id / GroupId（可選）

只存在你瀏覽器的 `localStorage`，不離開電腦。

## ✨ MiniMax AI 聊天助手

設定 token 後，AI 解讀分頁就是一個 chatbot：

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

加 30 天滾動 baseline 與 z-score 衍生欄位、effective z-score fallback
（資料稀疏時自動用整體平均代算），以及自製的 **Readiness Score** 與
**Environment Stress Score**。

## 兩種使用方式

### A. 純瀏覽器版（推薦）— GitHub Pages

`docs/` 內是純 HTML/JS 版本，所有解析在你的瀏覽器內進行，**資料不離開電腦**。

**iPhone 也能跑**：parser 用 streaming-aggregate 設計（邊讀邊算每日聚合，不保留
原始 record），記憶體佔用 1-5MB 而非 100-500MB，所以即使 Apple Health export
高達數 GB，iOS Safari 也不會因記憶體不足把 tab 殺掉。

部署到 GitHub Pages：

1. Repo Settings → Pages
2. Source: Deploy from a branch
3. Branch: 你目前的開發分支，Folder: `/docs`
4. 等 1–2 分鐘，`https://<user>.github.io/autohealth/` 即可使用

> 本機跑：`cd docs && python3 -m http.server`，瀏覽器開
> `http://localhost:8000`。**不要直接雙擊 index.html**，
> ES module 在 `file://` 下會被擋。

**沒檔案？** 上傳框下方的「🧪 看示範資料」按鈕載入 120 天合成資料，
可以先看儀表板長什麼樣再決定要不要傳真實資料。

### B. Python 版（本機 Streamlit）

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
streamlit run app.py
```

左側上傳 `匯出.zip`（內含 `export.xml`）即可。Streamlit 版的 AI 走伺服器端，
沒有瀏覽器跨域問題，CN 版 MiniMax 用這個最穩。

### C. 大檔離線分析 CLI

如果你的 export 很大（>1 GB / 數百萬筆 record）、或想配合 Claude Code / Jupyter 做
客製化分析，用 `scripts/parse_health.py`：

```bash
python scripts/parse_health.py /path/to/export.xml ./out
```

SQLite 暫存避免 OOM，產出 `health_daily.csv` 與 `health_daily.parquet`。

## 取得 Apple Health 匯出檔

iPhone「**健康** App → 個人頭像 → 匯出所有健康資料**」會產生 `匯出.zip`。

**iPhone 直接上傳就行**（streaming-aggregate parser 解決了 iOS Safari 記憶體限制）。
也可以 AirDrop 到 Mac、存 iCloud 雲碟、傳 Email 給自己後在桌機上傳。

## RWD（手機 / 平板 / 桌機自動適配）

- **桌機（≥ 1000px）**：vitals 卡 4 欄 × 2 列，分頁單排
- **平板（720-1000px）**：vitals 3 欄，分頁單排可橫滑
- **手機橫放（480-720px）**：vitals 2 欄，分頁換行
- **手機直放（< 480px）**：vitals 1 欄，分頁緊湊版 + 換行

所有分析期間日期選擇有快速按鈕：**近 1 月 / 近 3 月 / 近 1 年 / 全部**。

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
  app.js             # UI 與分頁互動 + vitals bar + 設定 modal + 聊天
  parser.js          # 瀏覽器內串流 XML / ZIP 解析（streaming-aggregate）
  aggregator.js      # 消費 dailyAggs → 每日寬表 + 30 天 baseline / z-score
  analyzer.js        # Spearman / 延遲相關 / 異常 / Readiness / Env Stress
  tasks.js           # 7 個分析任務的 render 邏輯（含 effectiveZScores fallback）
  ai.js              # MiniMax client + chat / 摘要 / 深度 prompt 建構
  styles.css
  demo.xml           # 內建 120 天合成示範資料

healthkit/           # Python 版（Streamlit）
  parser.py          # 串流解析 export.xml（可吃幾百 MB）
  aggregator.py      # 每日聚合（含睡眠分段、HR 衍生）
  analyzer.py        # 相關矩陣、延遲相關、異常偵測、洞察、Readiness
app.py               # Streamlit UI（含 sidebar AI 設定 + ✨ AI 解讀分頁）

scripts/
  parse_health.py        # 大檔 CLI 解析（SQLite buffered）
  make_sample_export.py  # 產合成 export 用於測試
  smoke_test.py / .mjs   # Python / JS 端對端測試
  qa_test.mjs            # 7 任務 render 自動測試（empty/short/missing-cols/leak detection）
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

## 設計細節（非必要閱讀）

**effective z-score fallback**：許多統計（warning days、readiness components、
trend detection）原本只看 cached 30 天 rolling z-score。對資料稀疏（剛買 Series 8、
某段沒戴 Watch、export 不完整）的用戶，cached z-score 大量 NaN → 整個分析失靈。
新版每處讀 z-score 都過 `effectiveZScores(frame, rawKey, zKey)`，cached 沒值就用整體
平均 / 標準差現算，閾值僅需 3 筆有效讀數即可運作。

**Task 6 carry-forward**：今日分數拆解的每個指標都會往前找 30 天最後一次有效讀數
（顯示「N 天前」），所以即使你今天忘了戴 Watch，分數依然有意義。

**Plain-language verdict**：所有任務分頁不再用 σ / partial correlation / Spearman 等
專業術語在主視覺。每個分頁頂部固定一個傳統三色（綠/黃/紅）狀態結論卡 +
一行動作建議，下面才是支撐資料。

**Streaming-aggregate parser**：原本載入所有 record 進 JS 物件再聚合（O(records) 記憶體），
改成邊讀邊算每日累加器（O(days × metrics) 記憶體）。對 1M+ 筆 HR 讀數的重度用戶，
記憶體從 100-500MB 降到 1-5MB，**iPhone Safari 不再因 OOM 殺 tab**。

## 注意

僅供生活資料探索之用，**不能取代醫療診斷**。任何持續性異常請諮詢醫師。
