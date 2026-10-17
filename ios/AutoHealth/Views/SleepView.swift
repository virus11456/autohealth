import SwiftUI
import Charts

struct SleepView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var settings: AppSettings
    @State private var period: ScoringEngine.Period = .days30

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    if let day = model.selected {
                        lastNightCard(day)
                        stagesCard(day)
                    }
                    PeriodPicker(period: $period)
                    let days = model.window(period)
                    if !days.isEmpty {
                        hoursChart(days)
                        scoreChart(days)
                        bedtimeChart(days)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("睡眠")
        }
    }

    private func lastNightCard(_ day: ScoredDay) -> some View {
        Card(title: Fmt.day(day.date) + " 的睡眠") {
            if day.sleep.score.isFinite, let s = day.metrics.sleep {
                HStack(spacing: 16) {
                    ScoreRing(value: day.sleep.score, color: scoreColor(day.sleep.score), size: 96, lineWidth: 10,
                              label: Fmt.int(day.sleep.score), sub: "睡眠分數")
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(Fmt.one(s.hours)) 小時").font(.title2.bold())
                        Text("\(Fmt.time(s.start)) → \(Fmt.time(s.end))").font(.caption).foregroundStyle(.secondary)
                        Text("目標 \(Fmt.one(settings.sleepGoalHours)) 小時").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
                VStack(spacing: 8) {
                    ForEach(day.sleep.parts) { p in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(p.label).font(.subheadline)
                                Spacer()
                                Text(p.text).font(.caption).foregroundStyle(.secondary)
                                Text(Fmt.int(p.score)).font(.subheadline.monospacedDigit().bold())
                            }
                            ProgressView(value: p.score, total: 100).tint(scoreColor(p.score))
                        }
                    }
                }
            } else {
                Text("這一天沒有睡眠紀錄。戴著 Apple Watch 睡覺並在「睡眠」App 開啟追蹤。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func stagesCard(_ day: ScoredDay) -> some View {
        Card(title: "睡眠階段") {
            if let s = day.metrics.sleep {
                StageBar(sleep: s)
                let columns = [GridItem(.flexible()), GridItem(.flexible())]
                LazyVGrid(columns: columns, spacing: 8) {
                    MetricTile(title: "在床時間", value: Fmt.one(s.inBedMinutes / 60), unit: "小時", color: .sleepColor)
                    MetricTile(title: "睡眠效率", value: s.efficiency.isFinite ? Fmt.int(s.efficiency * 100) : "—", unit: "%", color: .sleepColor)
                    MetricTile(title: "夜間清醒", value: Fmt.int(s.awakeMinutes), unit: "分", color: .awakeSleep)
                    MetricTile(title: "睡眠最低血氧", value: Fmt.one(day.metrics.spo2SleepMin), unit: "%", color: .cyan)
                }
            } else {
                Text("沒有資料").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func hoursChart(_ days: [ScoredDay]) -> some View {
        let points = days.filter { $0.metrics.sleepHours.isFinite }.map { DatePoint(date: $0.date, value: $0.metrics.sleepHours) }
        let avg = Stats.mean(points.map { $0.value })
        return Card(title: "睡眠時數") {
            Chart {
                ForEach(points) { p in
                    BarMark(x: .value("日期", p.date, unit: .day), y: .value("小時", p.value))
                        .foregroundStyle(p.value >= settings.sleepGoalHours ? Color.sleepColor : Color.sleepColor.opacity(0.45))
                        .cornerRadius(3)
                }
                RuleMark(y: .value("目標", settings.sleepGoalHours))
                    .foregroundStyle(Color.green)
                    .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                    .annotation(position: .top, alignment: .trailing) {
                        Text("目標 \(Fmt.one(settings.sleepGoalHours))h").font(.caption2).foregroundStyle(.green)
                    }
            }
            .chartXAxis { AxisMarks(values: .automatic(desiredCount: 5)) { _ in AxisValueLabel(format: .dateTime.month().day()) } }
            .frame(height: 170)
            Text("平均 \(Fmt.one(avg)) 小時 · \(points.filter { $0.value >= settings.sleepGoalHours }.count)/\(points.count) 天達標")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func scoreChart(_ days: [ScoredDay]) -> some View {
        let points = days.filter { $0.sleep.score.isFinite }.map { DatePoint(date: $0.date, value: $0.sleep.score) }
        return Card(title: "睡眠分數") {
            Chart(points) { p in
                LineMark(x: .value("日期", p.date, unit: .day), y: .value("分數", p.value))
                    .foregroundStyle(Color.sleepColor)
                    .interpolationMethod(.monotone)
                PointMark(x: .value("日期", p.date, unit: .day), y: .value("分數", p.value))
                    .foregroundStyle(scoreColor(p.value))
                    .symbolSize(20)
            }
            .chartYScale(domain: 0...100)
            .chartXAxis { AxisMarks(values: .automatic(desiredCount: 5)) { _ in AxisValueLabel(format: .dateTime.month().day()) } }
            .frame(height: 150)
        }
    }

    private func bedtimeChart(_ days: [ScoredDay]) -> some View {
        let points = days.filter { $0.metrics.bedtimeOffset.isFinite }.map { DatePoint(date: $0.date, value: $0.metrics.bedtimeOffset) }
        let goal = Stats.clockToOffset(settings.bedtimeGoal)
        return Card(title: "就寢時間") {
            if points.isEmpty {
                Text("沒有資料").font(.caption).foregroundStyle(.secondary)
            } else {
                Chart {
                    ForEach(points) { p in
                        PointMark(x: .value("日期", p.date, unit: .day), y: .value("就寢", p.value))
                            .foregroundStyle(abs(p.value - goal) <= 30 ? Color.green : Color.orange)
                            .symbolSize(28)
                    }
                    RuleMark(y: .value("目標", goal))
                        .foregroundStyle(Color.green.opacity(0.6))
                        .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                }
                .chartYAxis {
                    AxisMarks(values: .automatic(desiredCount: 4)) { value in
                        AxisGridLine()
                        AxisValueLabel {
                            if let v = value.as(Double.self) { Text(Stats.offsetToClock(v)).font(.caption2) }
                        }
                    }
                }
                .chartXAxis { AxisMarks(values: .automatic(desiredCount: 5)) { _ in AxisValueLabel(format: .dateTime.month().day()) } }
                .frame(height: 160)
                Text("目標 \(settings.bedtimeGoal)。綠點 = 與目標相差 30 分鐘內。作息愈規律，HRV 通常愈穩定。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
