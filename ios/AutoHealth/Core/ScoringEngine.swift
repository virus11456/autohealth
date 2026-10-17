import Foundation

// MARK: - Output types

enum StressLevel: String, CaseIterable {
    case relaxed, balanced, tense, high, none

    static func from(_ score: Double) -> StressLevel {
        guard score.isFinite else { return .none }
        if score <= 25 { return .relaxed }
        if score <= 50 { return .balanced }
        if score <= 75 { return .tense }
        return .high
    }

    var label: String {
        switch self {
        case .relaxed: return "放鬆"
        case .balanced: return "平衡"
        case .tense: return "緊繃"
        case .high: return "高壓"
        case .none: return "無資料"
        }
    }

    var emoji: String {
        switch self {
        case .relaxed: return "😌"
        case .balanced: return "🙂"
        case .tense: return "😬"
        case .high: return "😣"
        case .none: return "😶"
        }
    }
}

struct ScoreComponent: Identifiable {
    let id = UUID()
    var label: String
    var value: Double
    var text: String
}

struct SleepScorePart: Identifiable {
    var id: String { key }
    var key: String
    var label: String
    var score: Double
    var weight: Double
    var text: String
}

struct SleepScore {
    var score: Double = .nan
    var parts: [SleepScorePart] = []
}

enum HourState { case sleep, workout, awake, none }

struct HourSlot: Identifiable {
    var id: Int { hour }
    var hour: Int
    var state: HourState
    var stress: Double
    var heartRate: Double
    var sleepMinutes: Double
    var workoutMinutes: Double
}

struct BatteryDay {
    var curve: [Int] = Array(repeating: 50, count: 24)
    var wake: Int = 50
    var low: Int = 50
    var high: Int = 50
    var now: Int = 50
}

enum Trend { case up, down, stable }

struct HRVStatus {
    var recent: Double
    var baseline: Double
    var ratio: Double
    var low: Double
    var high: Double
    var trend: Trend
}

struct ScoredDay: Identifiable {
    let date: Date
    var id: Date { date }
    var metrics: DailyMetrics

    var stress: Double = .nan
    var level: StressLevel = .none
    var components: [ScoreComponent] = []

    var hrv: Double = .nan
    var hrvBaseline: Double = .nan
    var zHrv: Double = .nan
    var hrvStatus: HRVStatus?

    var restingHR: Double = .nan
    var rhrBaseline: Double = .nan
    var zRhr: Double = .nan
    var rhrSpread: Double = 2.5

    var sleep = SleepScore()
    var bedtimeBaseline: Double = .nan

    var recovery: Double = .nan
    var battery = BatteryDay()
    var intraday: [HourSlot] = []
    var awakeStress: Double = .nan
    var hasIntraday = false
}

enum AlertKind { case alert, watch, good, info }
enum AlertAction { case breathe, none }

struct DailyAlert: Identifiable {
    let id = UUID()
    var kind: AlertKind
    var icon: String
    var title: String
    var text: String
    var action: AlertAction = .none
}

// MARK: - Engine

enum ScoringEngine {

    // MARK: Sleep

    static func sleepScore(for m: DailyMetrics, bedtimeBaseline: Double) -> SleepScore {
        var parts: [SleepScorePart] = []
        let hours = m.sleepHours
        guard hours.isFinite, hours > 0 else { return SleepScore() }

        let dur = Stats.piecewise(hours, [(2, 5), (4, 20), (5, 45), (6, 70), (7, 90), (7.5, 100), (9.5, 100), (10.5, 85), (12, 70)])
        parts.append(SleepScorePart(key: "duration", label: "睡眠時數", score: dur, weight: 0.55,
                                    text: String(format: "%.1f 小時", hours)))

        let eff = m.sleepEfficiency
        if eff.isFinite {
            let e = Stats.clamp((eff - 0.75) / 0.2, 0, 1) * 100
            parts.append(SleepScorePart(key: "efficiency", label: "睡眠效率", score: e, weight: 0.15,
                                        text: String(format: "%.0f%%", eff * 100)))
        }

        if let s = m.sleep, s.deepMinutes + s.remMinutes > 0 {
            let total = hours * 60
            let deepPct = s.deepMinutes / total
            let remPct = s.remMinutes / total
            let deep = Stats.piecewise(deepPct, [(0.03, 20), (0.08, 60), (0.13, 100), (0.25, 100), (0.35, 70)])
            let rem = Stats.piecewise(remPct, [(0.05, 20), (0.12, 60), (0.18, 100), (0.30, 100), (0.40, 70)])
            parts.append(SleepScorePart(key: "stages", label: "深睡 / REM", score: (deep + rem) / 2, weight: 0.15,
                                        text: String(format: "深睡 %.0f%% · REM %.0f%%", deepPct * 100, remPct * 100)))
        }

        let bed = m.bedtimeOffset
        if bed.isFinite, bedtimeBaseline.isFinite {
            let diff = abs(bed - bedtimeBaseline)
            let cons = Stats.piecewise(diff, [(0, 100), (30, 100), (60, 70), (90, 45), (120, 20), (180, 5)])
            parts.append(SleepScorePart(key: "consistency", label: "作息規律", score: cons, weight: 0.15,
                                        text: "\(Stats.offsetToClock(bed)) 就寢（平常 \(Stats.offsetToClock(bedtimeBaseline))）"))
        }

        let wsum = parts.reduce(0) { $0 + $1.weight }
        var score = parts.reduce(0) { $0 + $1.score * $1.weight } / wsum
        // A short night can never be "good" no matter how efficient it was.
        score = min(score, dur + 20)
        return SleepScore(score: Stats.clamp(score, 0, 100), parts: parts)
    }

    // MARK: Intraday

    private static func overlapMinutes(hourStart: Date, intervals: [DateInterval]) -> Double {
        let hour = DateInterval(start: hourStart, duration: 3600)
        var total = 0.0
        for iv in intervals {
            if let inter = hour.intersection(with: iv) { total += inter.duration / 60 }
        }
        return total
    }

    static func intraday(date: Date, hourly: HourlyMetrics?, sleepIntervals: [DateInterval],
                         workoutIntervals: [DateInterval], rhrRef: Double, hrvRef: Double) -> [HourSlot] {
        let cal = Calendar.current
        var out: [HourSlot] = []
        out.reserveCapacity(24)
        for h in 0..<24 {
            let hs = cal.date(byAdding: .hour, value: h, to: date) ?? date
            let sleepMin = overlapMinutes(hourStart: hs, intervals: sleepIntervals)
            let workMin = overlapMinutes(hourStart: hs, intervals: workoutIntervals)
            let hr = hourly?.heartRate[h] ?? .nan
            let hrv = hourly?.hrv[h] ?? .nan
            var state: HourState = .none
            var stress: Double = .nan
            if sleepMin >= 30 { state = .sleep }
            else if workMin >= 10 { state = .workout }
            else if hr.isFinite { state = .awake }

            if state == .awake, hr.isFinite, rhrRef.isFinite {
                stress = 10 + (hr - rhrRef) * 2.2
            } else if state == .sleep, hr.isFinite, rhrRef.isFinite {
                stress = min(5 + (hr - (rhrRef - 5)) * 2, 60)
            }
            if stress.isFinite, hrv.isFinite, hrvRef.isFinite, hrv > 0, hrvRef > 0 {
                stress -= (log(hrv / hrvRef) / 0.3) * 10
            }
            if stress.isFinite { stress = Stats.clamp(stress, 0, 100) }
            out.append(HourSlot(hour: h, state: state, stress: stress, heartRate: hr,
                                sleepMinutes: sleepMin, workoutMinutes: workMin))
        }
        return out
    }

    // MARK: Main

    static func score(days input: [DailyMetrics], settings: ScoringSettings = .default) -> [ScoredDay] {
        let days = input.sorted { $0.date < $1.date }
        guard !days.isEmpty else { return [] }
        let cal = Calendar.current

        let hrvCol = days.map { $0.hrv }
        let rhrCol = days.map { $0.restingHeartRate }
        let bedCol = days.map { $0.bedtimeOffset }
        let window = max(7, settings.baselineDays)
        let byDate = Dictionary(uniqueKeysWithValues: days.map { ($0.date, $0) })

        var out: [ScoredDay] = []
        out.reserveCapacity(days.count)
        var battery = 60.0
        var lastSleepQuality = 0.65

        for (i, m) in days.enumerated() {
            var d = ScoredDay(date: m.date, metrics: m)

            // Baselines
            let hrvB = Stats.trailingBaseline(hrvCol, index: i, window: window)
            let rhrB = Stats.trailingBaseline(rhrCol, index: i, window: window)
            let bedB = Stats.trailingBaseline(bedCol, index: i, window: 14, minObs: 4)
            let hrvSpread = (hrvB.spread.isFinite && hrvB.spread > 0) ? hrvB.spread / max(1, hrvB.median) : 0.2
            let rhrSpread = (rhrB.spread.isFinite && rhrB.spread > 0) ? rhrB.spread : 2.5

            let hrv = m.hrv, rhr = m.restingHeartRate
            let zHrv: Double = (hrv.isFinite && hrvB.median.isFinite && hrv > 0 && hrvB.median > 0)
                ? Stats.clamp(log(hrv / hrvB.median) / max(0.08, hrvSpread), -3, 3) : .nan
            let zRhr: Double = (rhr.isFinite && rhrB.median.isFinite)
                ? Stats.clamp((rhr - rhrB.median) / max(1.5, rhrSpread), -3, 3) : .nan

            d.hrv = hrv; d.hrvBaseline = hrvB.median; d.zHrv = zHrv
            d.restingHR = rhr; d.rhrBaseline = rhrB.median; d.zRhr = zRhr; d.rhrSpread = rhrSpread
            d.bedtimeBaseline = bedB.median

            // Sleep
            d.sleep = sleepScore(for: m, bedtimeBaseline: bedB.median)
            if d.sleep.score.isFinite { lastSleepQuality = d.sleep.score / 100 }

            // Intraday: sleep that ended today (early hours) + sleep starting tonight
            var sleepIvs = m.sleep?.intervals ?? []
            if let next = byDate[cal.addingDays(1, to: m.date)], let s = next.sleep { sleepIvs += s.intervals }
            var workIvs = m.workouts.map { $0.interval }
            if let prev = byDate[cal.addingDays(-1, to: m.date)] { workIvs += prev.workouts.map { $0.interval } }
            let rhrRef = rhr.isFinite ? rhr : rhrB.median
            let hrvRef = hrvB.median.isFinite ? hrvB.median : hrv
            let slots = intraday(date: m.date, hourly: m.hourly, sleepIntervals: sleepIvs,
                                 workoutIntervals: workIvs, rhrRef: rhrRef, hrvRef: hrvRef)
            d.intraday = slots
            d.awakeStress = Stats.mean(slots.filter { $0.state == .awake }.map { $0.stress })
            d.hasIntraday = slots.contains { $0.state != .none }

            // Daily stress
            var comps: [ScoreComponent] = []
            if zHrv.isFinite {
                comps.append(ScoreComponent(label: "HRV 相對基準", value: -zHrv * 14,
                                            text: String(format: "%.0f ms（基準 %.0f）", hrv, hrvB.median)))
            }
            if zRhr.isFinite {
                comps.append(ScoreComponent(label: "靜息心率相對基準", value: zRhr * 12,
                                            text: String(format: "%.0f bpm（基準 %.0f）", rhr, rhrB.median)))
            }
            if d.awakeStress.isFinite {
                comps.append(ScoreComponent(label: "日間心率負荷", value: (d.awakeStress - 40) * 0.3,
                                            text: String(format: "日間平均即時壓力 %.0f", d.awakeStress)))
            }
            if d.sleep.score.isFinite {
                comps.append(ScoreComponent(label: "前晚睡眠", value: (60 - d.sleep.score) * 0.15,
                                            text: String(format: "睡眠分數 %.0f", d.sleep.score)))
            }
            if !comps.isEmpty {
                d.stress = Stats.clamp(45 + comps.reduce(0) { $0 + $1.value }, 0, 100)
            }
            d.components = comps
            d.level = StressLevel.from(d.stress)

            // Recovery
            var parts: [(Double, Double)] = []
            if zHrv.isFinite { parts.append((Stats.clamp(50 + 22 * zHrv, 0, 100), 0.4)) }
            if zRhr.isFinite { parts.append((Stats.clamp(50 - 22 * zRhr, 0, 100), 0.25)) }
            if d.sleep.score.isFinite { parts.append((d.sleep.score, 0.35)) }
            if !parts.isEmpty {
                let w = parts.reduce(0) { $0 + $1.1 }
                d.recovery = parts.reduce(0) { $0 + $1.0 * $1.1 } / w
            }

            // Body Battery (continuous hour-by-hour simulation)
            var curve = [Int](repeating: 50, count: 24)
            let dailyStress = d.stress.isFinite ? d.stress : 45
            var wakeLevel: Double = .nan
            var lowest = Double.infinity, highest = -Double.infinity, lastKnown: Double = .nan
            var prevState: HourState? = nil
            for h in 0..<24 {
                let slot = slots[h]
                var state = slot.state
                if state == .none {
                    state = (slot.sleepMinutes >= 30 || (h < 7 && !d.hasIntraday)) ? .sleep : .awake
                }
                let delta: Double
                switch state {
                case .sleep:
                    let sleepStress = slot.stress.isFinite ? slot.stress : 20
                    let frac = slot.sleepMinutes > 0 ? min(1, slot.sleepMinutes / 60) : 1
                    delta = (4.5 + 3 * lastSleepQuality - 1.5 * (sleepStress / 60)) * frac
                case .workout:
                    let frac = min(1, slot.workoutMinutes / 60)
                    delta = -(8 * frac) - 1.2 * (1 - frac)
                default:
                    let s = slot.stress.isFinite ? slot.stress : dailyStress
                    delta = -(1.2 + 4.5 * (s / 100))
                }
                battery = Stats.clamp(battery + delta, 5, 100)
                curve[h] = Int(battery.rounded())
                if prevState == .sleep, state != .sleep, !wakeLevel.isFinite { wakeLevel = battery }
                lowest = min(lowest, battery)
                highest = max(highest, battery)
                if slot.state != .none { lastKnown = battery }
                prevState = state
            }
            if !wakeLevel.isFinite { wakeLevel = Double(curve[7]) }
            d.battery = BatteryDay(curve: curve, wake: Int(wakeLevel.rounded()), low: Int(lowest.rounded()),
                                   high: Int(highest.rounded()), now: lastKnown.isFinite ? Int(lastKnown.rounded()) : curve[23])

            // HRV status (7-day mean vs baseline)
            let recent = Stats.mean(Array(hrvCol[max(0, i - 6)...i]))
            if recent.isFinite, hrvB.median.isFinite, hrvB.median > 0 {
                let ratio = recent / hrvB.median
                d.hrvStatus = HRVStatus(recent: recent, baseline: hrvB.median, ratio: ratio,
                                        low: hrvB.median * (1 - hrvSpread), high: hrvB.median * (1 + hrvSpread),
                                        trend: ratio > 1.05 ? .up : (ratio < 0.95 ? .down : .stable))
            }

            out.append(d)
        }
        return out
    }

    // MARK: Alerts

    static func alerts(for day: ScoredDay, previous: ScoredDay?, settings: ScoringSettings, isLatest: Bool) -> [DailyAlert] {
        var out: [DailyAlert] = []
        let m = day.metrics

        if day.restingHR.isFinite, day.rhrBaseline.isFinite {
            let threshold = max(5, 2 * day.rhrSpread)
            if day.restingHR - day.rhrBaseline >= threshold {
                out.append(DailyAlert(kind: .alert, icon: "💓", title: "靜息心率偏高",
                    text: String(format: "今天 %.0f bpm，比你的基準高 %.0f bpm。可能是睡眠不足、生病前兆或前一天飲酒／劇烈運動，留意身體訊號。",
                                 day.restingHR, day.restingHR - day.rhrBaseline)))
            }
        }

        if day.sleep.score.isFinite {
            let h = m.sleepHours
            let good = day.sleep.score >= 75
            let text: String
            if good { text = "睡得不錯，今天適合安排有挑戰的事。" }
            else if h < settings.sleepGoalHours {
                text = String(format: "距離 %.1f 小時目標還差 %.1f 小時，今晚試著提早就寢。", settings.sleepGoalHours, settings.sleepGoalHours - h)
            } else { text = "睡眠時數夠但品質一般，留意睡前咖啡因與螢幕。" }
            out.append(DailyAlert(kind: good ? .good : .watch, icon: "🌙",
                                  title: String(format: "昨晚睡了 %.1f 小時，睡眠分數 %.0f", h, day.sleep.score), text: text))
        } else if day.hasIntraday || day.restingHR.isFinite {
            out.append(DailyAlert(kind: .info, icon: "🌙", title: "沒有昨晚的睡眠紀錄",
                                  text: "戴著 Apple Watch 睡覺並開啟睡眠追蹤，才能計算睡眠分數與 Body Battery 充電。"))
        }

        if day.stress.isFinite, day.stress >= 70 {
            out.append(DailyAlert(kind: .alert, icon: "🧘", title: "今天壓力偏高",
                                  text: "HRV 低於平常、心率偏高。安排 3 分鐘呼吸練習，或把高強度訓練移到明天。", action: .breathe))
        } else if day.recovery.isFinite, day.recovery >= 75 {
            out.append(DailyAlert(kind: .good, icon: "⚡", title: "恢復狀態良好", text: "身體準備好了，今天可以挑戰高強度訓練或重要任務。"))
        }

        if day.battery.now <= 25 {
            out.append(DailyAlert(kind: .watch, icon: "🔋", title: "Body Battery 偏低",
                                  text: "目前約 \(day.battery.now)%。減少刺激、早點休息，讓今晚好好充電。"))
        }

        if m.steps.isFinite {
            if m.steps >= settings.stepsGoal {
                out.append(DailyAlert(kind: .good, icon: "🎯", title: "步數目標達成",
                                      text: "\(Int(m.steps).formatted()) 步，做得好！"))
            } else if isLatest {
                let gap = settings.stepsGoal - m.steps
                out.append(DailyAlert(kind: .info, icon: "🚶", title: "距離步數目標還差 \(Int(gap).formatted()) 步",
                                      text: gap < 2500 ? "出門走 20 分鐘就能達標。" : "今天活動量偏低，找機會多走動一下。"))
            }
        }

        if let s = day.hrvStatus, s.trend == .down, let p = previous?.hrvStatus, p.trend == .down {
            out.append(DailyAlert(kind: .watch, icon: "📉", title: "HRV 連續多日低於基準",
                                  text: "近一週 HRV 持續低於你的正常區間，身體可能在累積疲勞，安排一天完全休息。"))
        }
        return out
    }

    // MARK: Period aggregation

    struct PeriodPoint: Identifiable {
        var id: Date { start }
        var start: Date
        var label: String
        var value: Double
        var count: Int
    }

    enum Period: String, CaseIterable, Identifiable {
        case week7 = "7 天", days30 = "30 天", days90 = "90 天"
        var id: String { rawValue }
        var days: Int {
            switch self { case .week7: return 7; case .days30: return 30; case .days90: return 90 }
        }
    }

    static func stressDistribution(_ days: [ScoredDay]) -> [StressLevel: Int] {
        var counts: [StressLevel: Int] = [.relaxed: 0, .balanced: 0, .tense: 0, .high: 0]
        for d in days where d.stress.isFinite { counts[d.level, default: 0] += 1 }
        return counts
    }
}
