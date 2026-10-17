import Foundation

/// Per-hour buckets for one local day. Missing hours are `.nan`.
struct HourlyMetrics {
    var heartRate = [Double](repeating: .nan, count: 24)
    var heartRateMin = [Double](repeating: .nan, count: 24)
    var hrv = [Double](repeating: .nan, count: 24)
    var steps = [Double](repeating: .nan, count: 24)
    var energy = [Double](repeating: .nan, count: 24)

    var hasAnyHeartRate: Bool { heartRate.contains { $0.isFinite } }
}

/// One night of sleep, attributed to the calendar day the sleep ended on
/// (matches the Health app).
struct SleepSummary {
    var asleepMinutes: Double = 0
    var inBedMinutes: Double = 0
    var deepMinutes: Double = 0
    var coreMinutes: Double = 0
    var remMinutes: Double = 0
    var awakeMinutes: Double = 0
    var start: Date?
    var end: Date?
    /// Asleep intervals (stage-based when available, in-bed otherwise).
    var intervals: [DateInterval] = []

    var hours: Double { (asleepMinutes > 0 ? asleepMinutes : inBedMinutes) / 60 }
    var efficiency: Double { inBedMinutes > 0 ? asleepMinutes / inBedMinutes : .nan }

    /// Minutes after 18:00 of the preceding evening (23:30 -> 330, 01:00 -> 420).
    var bedtimeOffsetMinutes: Double {
        guard let s = start else { return .nan }
        let cal = Calendar.current
        var ref = cal.date(bySettingHour: 18, minute: 0, second: 0, of: s) ?? s
        if cal.component(.hour, from: s) < 18 { ref = cal.addingDays(-1, to: ref) }
        return s.timeIntervalSince(ref) / 60
    }
}

struct WorkoutSummary: Identifiable {
    let id: UUID
    var start: Date
    var end: Date
    var durationMinutes: Double
    var activityName: String
    var energyKcal: Double

    var interval: DateInterval { DateInterval(start: start, end: max(start, end)) }
}

/// Everything we know about one calendar day, straight from HealthKit.
struct DailyMetrics: Identifiable {
    let date: Date            // local midnight
    var id: Date { date }

    var steps: Double = .nan
    var activeEnergy: Double = .nan
    var distanceKm: Double = .nan
    var flights: Double = .nan
    var heartRate: Double = .nan
    var restingHeartRate: Double = .nan
    var hrv: Double = .nan
    var spo2: Double = .nan          // percent, daily mean
    var spo2SleepMin: Double = .nan  // lowest reading during sleep
    var respiratoryRate: Double = .nan
    var vo2Max: Double = .nan

    var sleep: SleepSummary?
    var hourly: HourlyMetrics?
    var workouts: [WorkoutSummary] = []

    var sleepHours: Double { sleep?.hours ?? .nan }
    var sleepEfficiency: Double { sleep?.efficiency ?? .nan }
    var bedtimeOffset: Double { sleep?.bedtimeOffsetMinutes ?? .nan }
}

/// User-tunable thresholds used by the scoring engine.
struct ScoringSettings {
    var stepsGoal: Double = 8000
    var sleepGoalHours: Double = 7.5
    var bedtimeGoal: String = "23:30"
    var baselineDays: Int = 28

    static let `default` = ScoringSettings()
}
