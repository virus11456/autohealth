# AutoHealth — 壓力 / HRV / Body Battery 監測（原生 iPhone App）

直接讀 iPhone「健康」(HealthKit) 的資料，在手機上算出壓力分數、即時壓力時間軸、
Body Battery、睡眠分數、恢復分數，並用本機通知主動提醒。**不需要匯出檔、不需要伺服器，
資料不離開手機。**

> 這個專案的程式碼是在沒有 Xcode 的 Linux 環境寫的：核心評分引擎（`AutoHealth/Core/`）
> 已用 Swift 6 工具鏈編譯並跑過數值測試；HealthKit 與 SwiftUI 層只做過語法檢查。
> **第一次在 Xcode Build 很可能有幾個型別錯誤要修**，把錯誤訊息貼回來即可。

## 需求

- Mac + Xcode 15.4 以上（建議 Xcode 16）
- iPhone（iOS 17+）+ Apple Watch（沒有 Watch 就沒有 HRV / 睡眠 / 連續心率）
- Apple ID（免費帳號可以裝到自己的手機，每 7 天要重新從 Xcode 安裝一次；
  長期使用或上架需要 Apple Developer Program，US$99 / 年）
- [XcodeGen](https://github.com/yonaskolb/XcodeGen)：`brew install xcodegen`

## 建置步驟

```bash
xcodegen generate          # 在 repo 根目錄執行，產生 AutoHealth.xcodeproj
open AutoHealth.xcodeproj
```

在 Xcode 裡：

1. 左側點 **AutoHealth** 專案 → TARGETS → AutoHealth → **Signing & Capabilities**。
2. **Team** 選你的 Apple ID（第一次要先在 Xcode → Settings → Accounts 登入）。
3. Bundle Identifier 如果被佔用，改成 `com.<你的名字>.autohealth`（`project.yml` 裡也改一下）。
4. 確認 Capabilities 裡有 **HealthKit**（含 Background Delivery）。沒有的話按 **+ Capability** 加上。
5. 用 USB 接上 iPhone，上方選你的手機，按 **▶ Run**。
6. 第一次啟動 iPhone 會跳「健康」授權畫面：**全部打開**。接著允許通知。
7. iPhone 設定 → 一般 → VPN 與裝置管理 → 信任你的開發者憑證（免費帳號第一次需要）。

模擬器會顯示「這台裝置沒有健康資料」，請用實機。

## 功能對照（第一輪 MVP）

| 分頁 | 內容 |
|---|---|
| 今日 | 壓力分數環 + 等級 + 「為什麼是這個分數」、Body Battery 現值與 24 小時曲線、恢復 / HRV / 靜息心率 / 血氧、即時壓力時間軸（每小時）、今日提醒卡、昨晚睡眠、活動、呼吸練習入口。左右箭頭可看過去任一天。 |
| 壓力 | 7 / 30 / 90 天壓力分數長條、壓力分布、HRV 趨勢（含個人正常區間）、靜息心率 vs 基準、日間即時壓力。 |
| 睡眠 | 睡眠分數與四個子項（時數、效率、深睡/REM、作息規律）、睡眠階段條、時數 / 分數 / 就寢時間趨勢。 |
| 活動 | 步數環、活動消耗、距離、樓層、VO₂ Max、步數趨勢、運動紀錄。 |
| 設定 | 步數 / 睡眠 / 就寢目標、基準視窗、讀取歷史、通知開關與測試、重新讀取、健康權限說明。 |

**背景監測**：HealthKit Background Delivery 會在 Apple Watch 同步新資料時喚醒 app，
重新計算並發出本機通知（早安睡眠摘要、靜息心率偏高、壓力偏高、傍晚步數提醒），每天各最多一次。

**第二輪（尚未做）**：桌面 Widget、習慣養成清單、週／月報告。
**第三輪**：Apple Watch app（按一下量 60 秒即時壓力、錶面複雜功能）。

## 演算法

- **個人基準**：HRV 與靜息心率取過去 28 天（可調）的中位數與離散度（MAD）。
- **壓力分數**：45 為起點，HRV 低於基準加分、靜息心率高於基準加分、日間心率負荷加分、前晚睡不好加分，限制在 0–100。
  0–25 放鬆、26–50 平衡、51–75 緊繃、76–100 高壓。
- **即時壓力**：每小時平均心率相對靜息心率，排除運動時段，睡眠時段另計；該小時若有 HRV 樣本會再修正。
- **Body Battery**：逐小時模擬，睡眠時依睡眠品質充電（約 +5～7 / 小時），清醒時依壓力放電（約 −1.5～−5 / 小時），運動加速放電，跨日連續。
- **睡眠分數**：時數 55%、效率 15%、深睡 / REM 比例 15%、作息規律 15%，且不超過「時數分 + 20」。
- **恢復分數**：HRV 40%、靜息心率 25%、睡眠 35%。

## 在沒有 Xcode 的機器上驗證核心引擎

```bash
Tools/check-core.sh          # 需要 swift 工具鏈（macOS 或 Linux 皆可）
```

會用合成資料跑 120 天，印出最近 10 天的分數並檢查範圍與極端情境。

## 專案結構

```
.
  project.yml                 # XcodeGen 規格（Info.plist / entitlements 由此產生）
  AutoHealth/
    App/        AutoHealthApp, AppModel（狀態）, AppSettings, NotificationService
    Core/       Stats, Models, ScoringEngine     ← 純 Foundation，可在 Linux 測
    Health/     HealthStore                      ← HealthKit 讀取、背景觀察
    Views/      RootView, TodayView, StressView, SleepView, ActivityView, SettingsView,
                BreathingView, Components（圖表與元件）
    Assets.xcassets
  Tools/        check-core.sh + CoreCheck/main.swift（Linux/macOS 數值測試）
```

## 決策紀錄

原本的「匯出 Apple Health zip 再分析」網頁版已移除，改為直接讀 HealthKit 的原生 app；方案比較見 [`PLAN.md`](PLAN.md)。

## 免責聲明

AutoHealth 不是醫療器材，不提供診斷或醫療建議；分數僅供生活參考。長期或過度的壓力請諮詢專業人員。
