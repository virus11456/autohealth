import SwiftUI
import Charts

struct ActivityView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var settings: AppSettings
    @State private var period: ScoringEngine.Period = .days30

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    if let day = model.selected { todayCard(day) }
                    PeriodPicker(period: $period)
                    let days = model.window(period)
                    if !days.isEmpty {
                        stepsChart(days)
                        workoutsCard(days)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("活動")
        }
    }

    private func todayCard(_ day: ScoredDay) -> some View {
        let m = day.metrics
        return Card(title: Fmt.day(day.date)) {
            HStack(spacing: 16) {
                ScoreRing(value: m.steps, maximum: settings.stepsGoal, color: .green, size: 96, lineWidth: 10,
                          label: Fmt.thousands(m.steps), sub: "步")
                VStack(alignment: .leading, spacing: 4) {
                    Text(m.steps.isFinite && m.steps >= settings.stepsGoal ? "🎯 目標達成" : "目標 \(Int(settings.stepsGoal).formatted()) 步")
                        .font(.headline)
                    if m.steps.isFinite, m.steps < settings.stepsGoal {
                        Text("還差 \(Int((settings.stepsGoal - m.steps).rounded()).formatted()) 步").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            let columns = [GridItem(.flexible()), GridItem(.flexible())]
            LazyVGrid(columns: columns, spacing: 8) {
                MetricTile(title: "活動消耗", value: Fmt.int(m.activeEnergy), unit: "kcal", color: .orange)
                MetricTile(title: "步行距離", value: Fmt.one(m.distanceKm), unit: "km", color: .green)
                MetricTile(title: "爬樓層", value: Fmt.int(m.flights), unit: "層", color: .green)
                MetricTile(title: "VO₂ Max", value: Fmt.one(latestVo2(before: day)), unit: "ml/kg/min", color: .mint)
            }
        }
    }

    private func latestVo2(before day: ScoredDay) -> Double {
        for d in model.days.reversed() where d.date <= day.date && d.metrics.vo2Max.isFinite {
            return d.metrics.vo2Max
        }
        return .nan
    }

    private func stepsChart(_ days: [ScoredDay]) -> some View {
        let points = days.filter { $0.metrics.steps.isFinite }.map { DatePoint(date: $0.date, value: $0.metrics.steps) }
        let avg = Stats.mean(points.map { $0.value })
        return Card(title: "步數") {
            Chart {
                ForEach(points) { p in
                    BarMark(x: .value("日期", p.date, unit: .day), y: .value("步數", p.value))
                        .foregroundStyle(p.value >= settings.stepsGoal ? Color.green : Color.green.opacity(0.45))
                        .cornerRadius(3)
                }
                RuleMark(y: .value("目標", settings.stepsGoal))
                    .foregroundStyle(Color.gray)
                    .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
            }
            .chartXAxis { AxisMarks(values: .automatic(desiredCount: 5)) { _ in AxisValueLabel(format: .dateTime.month().day()) } }
            .frame(height: 170)
            Text("平均 \(Fmt.thousands(avg)) 步 · \(points.filter { $0.value >= settings.stepsGoal }.count)/\(points.count) 天達標")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func workoutsCard(_ days: [ScoredDay]) -> some View {
        let workouts = days.flatMap { $0.metrics.workouts }.sorted { $0.start > $1.start }
        let totalMin = workouts.reduce(0) { $0 + $1.durationMinutes }
        return Card(title: "運動紀錄") {
            if workouts.isEmpty {
                Text("這段期間沒有運動紀錄。").font(.caption).foregroundStyle(.secondary)
            } else {
                Text("\(workouts.count) 次 · 共 \(Int(totalMin.rounded())) 分鐘").font(.caption).foregroundStyle(.secondary)
                ForEach(workouts.prefix(15)) { w in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(w.activityName).font(.subheadline)
                            Text("\(Fmt.shortDay(w.start)) \(Fmt.time(w.start))").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            Text("\(Int(w.durationMinutes.rounded())) 分").font(.subheadline.monospacedDigit())
                            if w.energyKcal.isFinite {
                                Text("\(Fmt.int(w.energyKcal)) kcal").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }
}
