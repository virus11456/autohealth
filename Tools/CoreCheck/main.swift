// Linux-runnable sanity check for the Foundation-only scoring core.
// Usage: ios/Tools/check-core.sh   (copies Core/*.swift + this file into a temp
// SwiftPM package and runs it). Generates 120 days of synthetic data with
// intraday heart rate, sleep stages and workouts, then prints score summaries
// and asserts basic invariants.
import Foundation

setvbuf(stdout, nil, _IONBF, 0)

struct RNG {
    var state: UInt64
    mutating func next() -> Double {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return Double(state >> 11) / Double(1 << 53)
    }
    mutating func gauss(_ sd: Double = 1) -> Double {
        let u = max(1e-12, next()), v = next()
        return sqrt(-2 * log(u)) * cos(2 * .pi * v) * sd
    }
}

func makeDemo(days: Int = 120) -> [DailyMetrics] {
    var rng = RNG(state: 42)
    let cal = Calendar.current
    let today = cal.startOfDay(for: Date())
    var out: [DailyMetrics] = []
    for d in 0..<days {
        let date = cal.date(byAdding: .day, value: d - days + 1, to: today)!
        let weekday = cal.component(.weekday, from: date)
        let weekend = weekday == 1 || weekday == 7
        let stressful = !weekend && rng.next() < 0.3
        var sleepHours = 7.3 - (stressful ? 1.0 : 0) + rng.gauss(0.45)
        if d == days - 25 { sleepHours = 3.9 }
        sleepHours = max(3.5, min(9.5, sleepHours))
        let bedMinutes = 23 * 60 + 15 + Int(rng.gauss(28))
        let prevDay = cal.date(byAdding: .day, value: -1, to: date)!
        let bedStart = cal.date(byAdding: .minute, value: bedMinutes, to: prevDay)!
        let inBedMin = sleepHours * 60 / 0.9
        let sleepEnd = bedStart.addingTimeInterval(inBedMin * 60)

        var m = DailyMetrics(date: date)
        var s = SleepSummary()
        s.start = bedStart; s.end = sleepEnd
        s.inBedMinutes = inBedMin
        s.asleepMinutes = sleepHours * 60
        s.deepMinutes = sleepHours * 60 * 0.17
        s.remMinutes = sleepHours * 60 * 0.22
        s.coreMinutes = s.asleepMinutes - s.deepMinutes - s.remMinutes
        s.awakeMinutes = inBedMin - s.asleepMinutes
        s.intervals = [DateInterval(start: bedStart.addingTimeInterval(600), end: sleepEnd)]
        m.sleep = s

        let rhr = 58 + 4 * Double(d) / Double(days) - 1.6 * (sleepHours - 7.2) + (stressful ? 3.5 : 0) + rng.gauss(1.4) + (d == days - 25 ? 7 : 0)
        let hrv = max(12, 52 + 4.5 * (sleepHours - 7.2) - (stressful ? 10 : 0) - 6 * Double(d) / Double(days) + rng.gauss(5) - (d == days - 25 ? 15 : 0))
        m.restingHeartRate = rhr.rounded()
        m.hrv = hrv
        m.spo2 = 97 + rng.gauss(0.5)
        m.respiratoryRate = 14 + rng.gauss(1)

        if (weekday == 3 || weekday == 5) && !weekend {
            let ws = cal.date(bySettingHour: 18, minute: 30, second: 0, of: date)!
            m.workouts = [WorkoutSummary(id: UUID(), start: ws, end: ws.addingTimeInterval(45 * 60), durationMinutes: 45, activityName: "Running", energyKcal: 400)]
        }

        var h = HourlyMetrics()
        var steps = 0.0
        for hour in 0..<24 {
            let t = cal.date(byAdding: .hour, value: hour, to: date)!
            let asleep = t >= bedStart && t < sleepEnd
            let inWorkout = m.workouts.contains { $0.interval.contains(t.addingTimeInterval(1800)) }
            if asleep { h.heartRate[hour] = rhr - 6 + rng.gauss(2) }
            else if inWorkout { h.heartRate[hour] = 140 + rng.gauss(6) }
            else {
                let dayCurve = 10 + 10 * sin((Double(hour) - 8) / 14 * .pi)
                h.heartRate[hour] = rhr + dayCurve + (stressful ? 9 : 0) + rng.gauss(5)
            }
            h.heartRateMin[hour] = h.heartRate[hour] - 5
            if hour == 3 { h.hrv[hour] = hrv + rng.gauss(5) }
            if !asleep && hour >= 7 && hour <= 22 {
                let st = 300 + 500 * rng.next() + (inWorkout ? 4000 : 0)
                h.steps[hour] = st; h.energy[hour] = st * 0.045
                steps += st
            }
        }
        m.hourly = h
        m.steps = steps.rounded()
        m.activeEnergy = steps * 0.045 + (m.workouts.isEmpty ? 0 : 400)
        m.distanceKm = steps * 0.00074
        out.append(m)
    }
    return out
}

let demo = makeDemo()
let scored = ScoringEngine.score(days: demo, settings: .default)
precondition(scored.count == demo.count, "scored count mismatch")

let fmt = DateFormatter(); fmt.dateFormat = "MM-dd"
print("date   stress lvl    sleep  recov  batt(wake/low/now)  hrv/base   rhr/base")
for d in scored.suffix(10) {
    print(String(format: "%@  %5.1f  %@  %5.1f  %5.1f   %3d/%3d/%3d        %4.0f/%4.0f  %3.0f/%3.0f",
                 fmt.string(from: d.date), d.stress, d.level.label, d.sleep.score, d.recovery,
                 d.battery.wake, d.battery.low, d.battery.now, d.hrv, d.hrvBaseline, d.restingHR, d.rhrBaseline))
}

// Invariants
for d in scored {
    if d.stress.isFinite { precondition(d.stress >= 0 && d.stress <= 100, "stress out of range") }
    if d.sleep.score.isFinite { precondition(d.sleep.score >= 0 && d.sleep.score <= 100, "sleep out of range") }
    for v in d.battery.curve { precondition(v >= 5 && v <= 100, "battery out of range") }
    precondition(d.intraday.count == 24)
}
let bad = scored[scored.count - 25]
let neighbours = Array(scored[(scored.count - 40)..<(scored.count - 26)]) + Array(scored[(scored.count - 24)..<(scored.count - 10)])
let typical = Stats.median(neighbours.map { $0.stress })
print("\nterrible night (\(fmt.string(from: bad.date))): stress=\(Int(bad.stress)) sleep=\(Int(bad.sleep.score)) recovery=\(Int(bad.recovery))")
print("typical neighbouring day: stress=\(Int(typical))")
precondition(bad.stress > typical + 10, "bad night should score more stress")
precondition(bad.sleep.score < 45, "3.9h sleep should score low")

let latest = scored.last!
let alerts = ScoringEngine.alerts(for: latest, previous: scored.dropLast().last, settings: .default, isLatest: true)
print("\nalerts for latest day:")
for a in alerts { print("  [\(a.kind)] \(a.icon) \(a.title) — \(a.text)") }

let awake = latest.intraday.filter { $0.state == .awake }
precondition(!awake.isEmpty, "expected awake hours")
print("\nintraday states: sleep=\(latest.intraday.filter { $0.state == .sleep }.count) awake=\(awake.count) workout=\(latest.intraday.filter { $0.state == .workout }.count)")
let dist = ScoringEngine.stressDistribution(Array(scored.suffix(30)))
print("30-day distribution: \(dist.map { "\($0.key.label)=\($0.value)" }.sorted().joined(separator: " "))")
print("\nOK")
