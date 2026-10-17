import Foundation
import Combine

/// User preferences, persisted in UserDefaults.
final class AppSettings: ObservableObject {
    private let defaults = UserDefaults.standard

    @Published var stepsGoal: Double { didSet { defaults.set(stepsGoal, forKey: "stepsGoal") } }
    @Published var sleepGoalHours: Double { didSet { defaults.set(sleepGoalHours, forKey: "sleepGoalHours") } }
    @Published var bedtimeGoal: String { didSet { defaults.set(bedtimeGoal, forKey: "bedtimeGoal") } }
    @Published var baselineDays: Int { didSet { defaults.set(baselineDays, forKey: "baselineDays") } }
    @Published var historyDays: Int { didSet { defaults.set(historyDays, forKey: "historyDays") } }
    @Published var notificationsEnabled: Bool { didSet { defaults.set(notificationsEnabled, forKey: "notificationsEnabled") } }

    init() {
        let d = UserDefaults.standard
        stepsGoal = d.object(forKey: "stepsGoal") as? Double ?? 8000
        sleepGoalHours = d.object(forKey: "sleepGoalHours") as? Double ?? 7.5
        bedtimeGoal = d.string(forKey: "bedtimeGoal") ?? "23:30"
        baselineDays = d.object(forKey: "baselineDays") as? Int ?? 28
        historyDays = d.object(forKey: "historyDays") as? Int ?? 120
        notificationsEnabled = d.object(forKey: "notificationsEnabled") as? Bool ?? true
    }

    var scoring: ScoringSettings {
        ScoringSettings(stepsGoal: stepsGoal, sleepGoalHours: sleepGoalHours,
                        bedtimeGoal: bedtimeGoal, baselineDays: baselineDays)
    }
}
