import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var settings: AppSettings

    private let bedtimes: [String] = {
        var out: [String] = []
        for h in [21, 22, 23, 0, 1, 2] {
            for m in [0, 30] { out.append(String(format: "%02d:%02d", h, m)) }
        }
        return out
    }()

    var body: some View {
        NavigationStack {
            Form {
                Section("目標") {
                    Stepper("步數目標：\(Int(settings.stepsGoal).formatted()) 步", value: $settings.stepsGoal, in: 2000...30000, step: 500)
                    Stepper("睡眠目標：\(Fmt.one(settings.sleepGoalHours)) 小時", value: $settings.sleepGoalHours, in: 5...10, step: 0.5)
                    Picker("就寢目標", selection: $settings.bedtimeGoal) {
                        ForEach(bedtimes, id: \.self) { Text($0).tag($0) }
                    }
                }

                Section {
                    Picker("個人基準視窗", selection: $settings.baselineDays) {
                        Text("14 天").tag(14)
                        Text("28 天").tag(28)
                        Text("60 天").tag(60)
                    }
                    Picker("讀取歷史", selection: $settings.historyDays) {
                        Text("60 天").tag(60)
                        Text("120 天").tag(120)
                        Text("180 天").tag(180)
                        Text("365 天").tag(365)
                    }
                } header: {
                    Text("分析")
                } footer: {
                    Text("壓力與恢復分數都是相對於你自己的基準（視窗內的中位數），不是跟別人比。歷史愈長、基準愈穩定，但讀取會變慢。")
                }

                Section {
                    Toggle("智慧提醒", isOn: $settings.notificationsEnabled)
                    Button("發送測試通知") { Task { await model.notifications.sendTest() } }
                } header: {
                    Text("通知")
                } footer: {
                    Text("早安睡眠摘要、靜息心率偏高、壓力偏高、傍晚步數提醒。全部由手機本機判斷，每天最多各一次，不經過任何伺服器。")
                }

                Section("資料") {
                    LabeledContent("上次更新", value: model.lastRefresh.map { Fmt.timeFormatter.string(from: $0) } ?? "—")
                    LabeledContent("已讀取天數", value: "\(model.days.count)")
                    Button {
                        Task { await model.refresh(reason: .manual) }
                    } label: {
                        if model.isRefreshing { ProgressView() } else { Text("重新讀取健康資料") }
                    }
                    .disabled(model.isRefreshing)
                    if let err = model.errorMessage {
                        Text(err).font(.caption).foregroundStyle(.red)
                    }
                }

                Section {
                    Text("若看不到資料，請到 iPhone「健康」App → 右上角頭像 → 隱私 → App 與服務 → AutoHealth，開啟全部讀取權限。")
                        .font(.caption)
                    Link("打開系統設定", destination: URL(string: UIApplication.openSettingsURLString)!)
                } header: {
                    Text("健康權限")
                }

                Section("關於") {
                    LabeledContent("版本", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—")
                    Text("AutoHealth 不是醫療器材，不提供診斷或醫療建議。所有健康資料只在這台 iPhone 上處理，不會上傳。長期或過度的壓力請諮詢專業人員。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("設定")
        }
    }
}
