import SwiftUI

struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Group {
            switch model.authState {
            case .unknown, .requesting:
                VStack(spacing: 16) {
                    ProgressView()
                    Text("連接「健康」資料…").foregroundStyle(.secondary)
                }
            case .unavailable:
                message(icon: "heart.slash", title: "這台裝置沒有健康資料",
                        text: "AutoHealth 需要 iPhone 上的「健康」App 與 Apple Watch 的量測資料。模擬器與 iPad 不支援。")
            case .failed(let reason):
                VStack(spacing: 16) {
                    message(icon: "exclamationmark.triangle", title: "無法取得健康權限", text: reason)
                    Button("再試一次") { Task { await model.retryAuthorization() } }
                        .buttonStyle(.borderedProminent)
                }
            case .ready:
                TabView {
                    TodayView().tabItem { Label("今日", systemImage: "heart.fill") }
                    StressView().tabItem { Label("壓力", systemImage: "waveform.path.ecg") }
                    SleepView().tabItem { Label("睡眠", systemImage: "moon.zzz.fill") }
                    ActivityView().tabItem { Label("活動", systemImage: "figure.walk") }
                    SettingsView().tabItem { Label("設定", systemImage: "gearshape.fill") }
                }
            }
        }
    }

    private func message(icon: String, title: String, text: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: icon).font(.system(size: 44)).foregroundStyle(.secondary)
            Text(title).font(.title3.bold())
            Text(text).multilineTextAlignment(.center).foregroundStyle(.secondary)
        }
        .padding(32)
    }
}
