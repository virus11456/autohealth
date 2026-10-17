# AutoHealth → 「WellDo 式」壓力 / HRV 監測 App 企劃

> 目的：決定要用哪種形式做出能**直接讀取健康數據、在手機上持續監測**的 app（參考 WellDo），而不是靠手動匯出 Apple Health 檔案。
> **決定：走方案 A（原生 iOS + watchOS）。** 第一輪 iPhone MVP 已在 `ios/` 實作，建置方式見 `ios/README.md`。以下保留當初的方案比較。

---

## 0. 先回答你的問題：我寫的 app 能直接讀健康數據、在手機上監控嗎？

**可以，但只有「原生 iOS app」做得到。** 關鍵事實：

| 問題 | 答案 |
|---|---|
| 網頁 / PWA 能讀 Apple 健康 (HealthKit) 嗎？ | **不能。** Apple 不開放瀏覽器讀 HealthKit，這就是現在這個專案要你手動匯出的原因。 |
| 什麼能讀？ | 用 Swift 寫的 iOS app（或 Flutter / React Native 包 HealthKit 外掛），安裝在 iPhone 上，向你要一次授權後就能讀心率、HRV、靜息心率、睡眠、步數、血氧…… |
| 能「即時」監測嗎？ | **背景監測可以**：HealthKit 有 Background Delivery，Apple Watch 每寫入新樣本（心率約每 5–10 分鐘、HRV 一天數次、睡眠早上結算）iPhone app 就被喚醒，可以計算並發本機通知（靜息心率偏高、早安睡眠摘要、壓力偏高提醒）。<br>**秒級即時**要再做一個 Apple Watch 端 app，主動串流心率 1–2 分鐘來「現在量一下」。WellDo 就是 iPhone + Watch 兩個 app。 |
| 我（Claude）在這個環境能做到哪？ | 我能寫完整的 Swift / SwiftUI / HealthKit / WidgetKit 程式碼並放進這個 repo，**但這裡是 Linux 容器，沒有 Xcode，無法編譯、無法裝到你的手機。** 需要你（或你的 Mac）負責「打開 Xcode → 按 Run」。遇到編譯錯誤把訊息貼給我，我修。 |
| 要花錢嗎？ | 裝在自己手機測試：**免費 Apple ID 即可**（app 每 7 天要重新從 Xcode 安裝一次）。想長期用或上架 App Store：Apple Developer Program **US$99 / 年**。 |
| 安卓？ | HealthKit 只有 iOS。安卓要走 Health Connect，等於另一套；若你只有 iPhone + Apple Watch，建議先不考慮。 |

**你需要準備的東西（決定方案前請確認）：**
1. 有沒有 **Mac**（Xcode 只能在 macOS 跑）？
2. 有沒有 **Apple Watch**（沒有的話 HRV / 睡眠 / 連續心率幾乎沒資料，WellDo 類 app 就沒意義）？
3. 願不願意每 7 天用 Xcode 重裝一次（免費）或付 US$99 / 年？

---

## 1. 三個可行方案

### 方案 A：原生 iOS + watchOS App（SwiftUI + HealthKit）— 最接近 WellDo ★推薦（有 Mac 的話）

**做法**：在 repo 新增 `ios/` 目錄，Xcode 專案含三個 target：
- `AutoHealth`（iPhone 主 app）
- `AutoHealthWatch`（Watch app：即時量測、錶面複雜功能）
- `AutoHealthWidgets`（iPhone 桌面 widget）

**功能（對照 WellDo）**

| WellDo 功能 | 我們的做法 |
|---|---|
| 壓力分數（0–100） | HRV + 靜息心率相對「個人 28 天基準」的偏離，加前晚睡眠、日間心率負荷。演算法已在這次對話寫好（`docs/scoring.js`），搬到 Swift。 |
| 即時壓力時間軸 | HealthKit 心率樣本按小時 vs 靜息心率，排除運動時段與睡眠。 |
| Body Battery | 睡眠充電、壓力/運動放電的逐小時模擬，跨日連續。 |
| 睡眠分數 + 階段 | HealthKit 睡眠分析（深睡 / 核心 / REM / 清醒）、效率、作息規律。 |
| HRV 趨勢、靜息心率 | 7 天 vs 基準、個人正常區間帶。 |
| 日 / 週 / 月趨勢 | 本機 SwiftUI Charts。 |
| 智慧通知 | HealthKit Background Delivery + 本機通知：早安睡眠摘要、靜息心率偏高、傍晚步數提醒、壓力偏高建議呼吸。**不需要伺服器。** |
| Watch 錶面 / widget | WidgetKit：壓力分數、Body Battery、HRV、睡眠、步數。 |
| 習慣養成、正念呼吸 | 本機習慣清單 + 引導式呼吸（箱式 / 4-7-8 / 共振），呼吸時 Watch 端可記錄心率看效果。 |
| 隱私 | 所有資料留在手機，零伺服器。 |

**優點**：功能最完整、真正背景監測、隱私最好、零營運成本。
**缺點 / 風險**：
- 必須有 Mac + Xcode；我寫的程式碼在這裡無法編譯驗證，第一次 Build 很可能要來回修幾輪錯誤（正常情況 1–3 輪）。
- Watch app 的「秒級即時」在 Apple 限制下會耗電，實務上做成「按一下量 60 秒」。
- 免費帳號每 7 天重裝；上架需 US$99 / 年並過 App Store 審核（健康類審核較嚴）。

**分階段**
1. **MVP（第一輪交付）**：iPhone app 讀 HealthKit → 今日壓力 / Body Battery / 睡眠 / HRV 四張卡 + 7 / 30 天趨勢 + 本機通知。
2. **第二輪**：Widget、習慣養成、呼吸練習、週月報告。
3. **第三輪**：Watch app（即時量測、複雜功能）。

---

### 方案 B：不用 Mac 的「捷徑 + 網頁 App」自動同步

**做法**：利用 iOS 內建「捷徑 (Shortcuts)」的「尋找健康樣本」動作，設一個**自動化**（例如每天 07:00、12:00、18:00、22:00 各跑一次），自動把最近 24 小時的心率 / HRV / 睡眠 / 步數打包成 JSON，POST 到你自己的小型後端（Cloudflare Worker 或 Vercel + KV，免費額度夠用）。現有的網頁 app 改成 PWA 從後端讀資料，加到主畫面就像一般 app，並可用 Web Push 發通知（iOS 16.4+ 支援）。

**優點**：不需要 Mac、不需要 Xcode、不用開發者帳號，用現在已經寫好的瀏覽器版（解析 / 評分 / 圖表）就能接。
**缺點**：
- 不是真正即時：最密只能排到「每小時跑一次捷徑」，而且 iOS 偶爾會跳確認視窗。
- 健康數據會離開手機、放到你自己的雲端（雖然是你自己的帳號，但隱私等級低於方案 A）。
- 沒有 Watch 錶面、沒有 Watch 端即時量測。
- 捷徑設定要你手動在 iPhone 上照步驟建立一次（我會寫一步步的教學）。

---

### 方案 C：跨平台 Flutter（iOS + Android）

**做法**：Flutter + `health` 套件同時讀 HealthKit 與 Android Health Connect。
**優點**：一套程式碼兩個平台。
**缺點**：iOS 端一樣需要 Mac + Xcode 才能編譯；Watch app 支援差；背景監測與通知要各寫原生橋接；比方案 A 多一層複雜度。**只有在你明確需要安卓時才值得。**

---

### （對照）方案 D：維持現在的「手動匯出」網頁版
你已經說不要匯出了，所以這裡只列出來對照：零安裝、零成本，但每次要看都得匯出一次 .zip，無法監控、無法通知。

---

## 2. 比較表

| | A 原生 iOS/watchOS | B 捷徑 + PWA | C Flutter | D 手動匯出 |
|---|---|---|---|---|
| 直接讀健康數據 | ✅ | ✅（經捷徑） | ✅ | ❌ |
| 背景監測 / 通知 | ✅ 本機 | ⚠️ 每小時級、Web Push | ⚠️ 要原生橋接 | ❌ |
| Watch 即時量測 / 錶面 | ✅（第三輪） | ❌ | ❌ | ❌ |
| 需要 Mac + Xcode | ✅ 需要 | ❌ 不需要 | ✅ 需要 | ❌ |
| 開發者帳號費用 | 免費（7 天重裝）或 US$99/年 | 免費 | 同 A | 免費 |
| 資料是否離開手機 | 否 | **是**（你的雲端） | 否 | 否 |
| 我在這裡能驗證到什麼程度 | 只能靜態檢查，不能編譯 | 後端 + 前端都能跑測試 | 同 A | 全部能跑 |
| 上線前你要做的事 | Xcode Run、貼錯誤給我 | 建一次捷徑、部署一次後端 | 同 A | 無 |
| 預估交付輪次 | MVP 1 輪 + 修錯 1–3 輪 | 1–2 輪 | 2–4 輪 | 已完成 |

---

## 3. 我的建議

- **有 Mac + Apple Watch → 選 A。** 這是唯一能做到 WellDo 那種「裝著就一直監測、會主動提醒、資料不出手機」的路。先做 MVP（iPhone 端），穩定後再加 Widget 與 Watch。
- **沒有 Mac → 選 B。** 現有程式碼最大化重用，唯一要接受的是「每小時級」而非即時，以及資料放在你自己的雲端。
- 需要安卓才考慮 C。

---

## 4. 現在 repo 的狀態（供你決定時參考）

在你喊停之前，我已經為「網頁版重寫」寫了幾個模組（尚未 commit、尚未 push）：

- `docs/scoring.js`：壓力分數、即時壓力時間軸、Body Battery、睡眠分數、恢復分數、智慧提醒、日/週/月彙總 — **方案 A 會把它翻成 Swift，方案 B 直接沿用。**
- `docs/demo.js`：合成示範資料（含逐 10 分鐘心率、睡眠階段、運動）。
- `docs/charts.js`：無相依的 SVG 圖表（折線、長條、環形、壓力時間軸、Body Battery 曲線、睡眠階段條、相關矩陣）。
- `docs/store.js`：IndexedDB / localStorage 本機儲存。
- `docs/habits.js`：習慣清單、連續天數、自動完成、引導式呼吸。
- `docs/parser.js`、`docs/aggregator.js`：加了 Workout 解析與逐小時聚合（既有功能不變）。

這些在方案 A 是「演算法參考」，在方案 B 是「直接使用」。選 A 的話我會先保留它們但以 Swift 為主；若你想完全放棄網頁版，我也可以把這些改動丟掉。

---

## 5. 請你回覆

1. 走 **A / B / C** 哪一個？
2. 你有 Mac 嗎？有 Apple Watch 嗎（哪一代）？
3. 選 A 的話：先用免費 Apple ID（7 天重裝）還是你有 / 打算買開發者帳號？
4. 選 B 的話：後端放 Cloudflare 還是 Vercel（這個環境有 Vercel 連接器，可以直接幫你部署）？
5. 這次對話已寫好的網頁版模組：保留、還是丟掉？
