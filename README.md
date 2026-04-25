# AutoHealth — Apple Health 跨維度分析儀表板

> **🌐 公開網址**：<https://virus11456.github.io/autohealth/>
>
> 任何人都可以打開上面網址，**上傳自己的 Apple Health 匯出檔**做分析。
> 整個網站是 GitHub Pages 上的靜態頁面，**沒有後端、沒有資料庫**：
> 你的健康資料在瀏覽器裡解析、分析、繪圖，**不會送到任何伺服器、也不會被儲存**，
> 關掉分頁就消失，只有你自己看得到。原始碼公開可驗證。

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

## 兩種使用方式

### A. 純瀏覽器版（推薦）— GitHub Pages

`docs/` 內是純 HTML/JS 版本，所有解析在你的瀏覽器內進行，**資料不離開電腦**。
部署到 GitHub Pages 即可拿到一個公開網址自己用：

1. Repo Settings → Pages
2. Source: Deploy from a branch
3. Branch: `claude/health-analytics-dashboard-At7IF`，Folder: `/docs`
4. 等 1–2 分鐘，會給你 `https://<user>.github.io/autohealth/` 的網址

> 想本機跑也行：`cd docs && python3 -m http.server`，瀏覽器開
> `http://localhost:8000`。**不要直接雙擊 index.html**，瀏覽器
> 對 `file://` 下的 ES module 會擋。

### B. Python 版（本機，給愛 Streamlit 的人）

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

- **網站本身沒有後端**：GitHub Pages 上純靜態 HTML/JS，無伺服器、無資料庫、無第三方追蹤。
- **檔案不離開瀏覽器**：你選的 `匯出.zip` / `export.xml` 由瀏覽器內的 JS 直接解析，
  從頭到尾沒有 `fetch()` / `XMLHttpRequest()` 把檔案送出去。可以打開 DevTools →
  Network 分頁自己驗證：上傳檔案後不會看到任何 outgoing request。
- **關分頁即消失**：分析結果只存在當下頁面記憶體中，沒有寫入 `localStorage` /
  `IndexedDB` / cookie，關掉分頁就什麼都沒了。
- **原始碼公開**：整個 `docs/` 目錄就是線上跑的程式，可審。
- `.gitignore` 已排除 `export.xml` / `export.zip` / `data/` / `.cache/`，
  避免你把自己的資料不小心提交進 repo。

## 結構

```
docs/                # 純前端版（GitHub Pages 部署目標）
  index.html
  app.js             # UI 與互動
  parser.js          # 瀏覽器內串流 XML / ZIP 解析
  aggregator.js      # 每日聚合
  analyzer.js        # Spearman / 延遲相關 / 異常 / 洞察
  styles.css

healthkit/           # Python 版（Streamlit）
  parser.py          # 串流解析 export.xml（可吃幾百 MB）
  aggregator.py      # 各指標 → 每日聚合（含睡眠分段）
  analyzer.py        # 相關矩陣、延遲相關、異常偵測、洞察生成
app.py               # Streamlit UI

scripts/
  make_sample_export.py  # 產合成 export 用於測試
  smoke_test.py          # Python 端對端測試
  smoke_test.mjs         # JS 端對端測試（驗證兩版結果一致）
```

## 注意

僅供生活資料探索之用，**不能取代醫療診斷**。任何持續性異常請諮詢醫師。
