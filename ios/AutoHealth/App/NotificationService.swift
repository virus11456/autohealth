import Foundation
import UserNotifications

/// Local "smart" notifications: morning sleep summary, elevated resting heart
/// rate, high stress and an evening step reminder. Each is sent at most once
/// per day; nothing goes through a server.
final class NotificationService {
    static let shared = NotificationService()

    private let center = UNUserNotificationCenter.current()
    private let defaults = UserDefaults.standard

    func requestAuthorization() async {
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    }

    func evaluate(latest: ScoredDay, previous: ScoredDay?, settings: ScoringSettings, enabled: Bool) async {
        guard enabled else { return }
        let key = Self.dayString(latest.date)
        let m = latest.metrics

        if latest.sleep.score.isFinite, !sent("sleep", key) {
            await post(id: "sleep-\(key)", title: "早安 🌙 睡眠分數 \(Int(latest.sleep.score.rounded()))",
                       body: String(format: "昨晚睡了 %.1f 小時，Body Battery 充到 %d%%。", m.sleepHours, latest.battery.wake))
            mark("sleep", key)
        }

        if latest.restingHR.isFinite, latest.rhrBaseline.isFinite,
           latest.restingHR - latest.rhrBaseline >= max(5, 2 * latest.rhrSpread), !sent("rhr", key) {
            await post(id: "rhr-\(key)", title: "💓 靜息心率偏高",
                       body: String(format: "今天 %.0f bpm，比你的基準高 %.0f bpm。留意休息與身體訊號。",
                                    latest.restingHR, latest.restingHR - latest.rhrBaseline))
            mark("rhr", key)
        }

        if latest.stress.isFinite, latest.stress >= 70, !sent("stress", key) {
            await post(id: "stress-\(key)", title: "🧘 今天壓力偏高（\(Int(latest.stress.rounded()))）",
                       body: "HRV 低於平常、心率偏高。花 3 分鐘做呼吸練習，或把高強度訓練移到明天。")
            mark("stress", key)
        }

        await scheduleStepReminder(steps: m.steps, goal: settings.stepsGoal)
    }

    /// One-off reminder at 18:00 today if the goal is still out of reach.
    func scheduleStepReminder(steps: Double, goal: Double) async {
        center.removePendingNotificationRequests(withIdentifiers: ["steps-reminder"])
        guard steps.isFinite, steps < goal else { return }
        let cal = Calendar.current
        guard let fireAt = cal.date(bySettingHour: 18, minute: 0, second: 0, of: Date()), fireAt > Date() else { return }
        let gap = Int((goal - steps).rounded())
        let content = UNMutableNotificationContent()
        content.title = "🚶 傍晚走一走"
        content.body = "距離今天的步數目標還差 \(gap.formatted()) 步，出門走 20 分鐘吧。"
        content.sound = .default
        let comps = cal.dateComponents([.year, .month, .day, .hour, .minute], from: fireAt)
        let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
        try? await center.add(UNNotificationRequest(identifier: "steps-reminder", content: content, trigger: trigger))
    }

    func sendTest() async {
        await post(id: "test-\(UUID().uuidString)", title: "AutoHealth 通知測試", body: "通知已正常運作。")
    }

    // MARK: Helpers

    private func post(id: String, title: String, body: String) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        try? await center.add(request)
    }

    private func sent(_ kind: String, _ day: String) -> Bool {
        defaults.bool(forKey: "notified.\(kind).\(day)")
    }

    private func mark(_ kind: String, _ day: String) {
        defaults.set(true, forKey: "notified.\(kind).\(day)")
    }

    static func dayString(_ date: Date) -> String {
        let f = DateFormatter()
        f.calendar = Calendar.current
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }
}
