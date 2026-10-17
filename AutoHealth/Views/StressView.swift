import SwiftUI
import Charts

struct StressView: View {
    @EnvironmentObject var model: AppModel
    @State private var period: ScoringEngine.Period = .days30

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    PeriodPicker(period: $period)
                    let days = model.window(period)
                    if days.isEmpty {
                        Text("沒有資料").foregroundStyle(.secondary).padding(.top, 60)
                    } else {
                        stressChart(days)
                        distributionCard(days)
                        hrvCard(days)
                        rhrCard(days)
                        awakeCard(days)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("壓力")
        }
    }

    // MARK: Stress

    private func stressChart(_ days: [ScoredDay]) -> some View {
        let points = days.filter { $0.stress.isFinite }
        let avg = Stats.mean(points.map { $0.stress })
        return Card(title: "每日壓力分數") {
            Chart(points) { d in
                BarMark(x: .value("日期", d.date, unit: .day), y: .value("壓力", d.stress))
                    .foregroundStyle(d.level.color)
                    .cornerRadius(3)
            }
            .chartYScale(domain: 0...100)
            .chartXAxis { AxisMarks(values: .automatic(desiredCount: 5)) { _ in AxisValueLabel(format: .dateTime.month().day()) } }
            .frame(height: 180)
            HStack {
                Text("平均 \(Fmt.int(avg)) · \(StressLevel.from(avg).emoji) \(StressLevel.from(avg).label)")
                Spacer()
                Text("\(points.count) 天").foregroundStyle(.secondary)
            }
            .font(.caption)
        }
    }

    private func distributionCard(_ days: [ScoredDay]) -> some View {
        let dist = ScoringEngine.stressDistribution(days)
        let order: [StressLevel] = [.relaxed, .balanced, .tense, .high]
        let total = order.reduce(0) { $0 + (dist[$1] ?? 0) }
        return Card(title: "壓力分布") {
            if total > 0 {
                GeometryReader { geo in
                    HStack(spacing: 2) {
                        ForEach(order, id: \.self) { lv in
                            let n = dist[lv] ?? 0
                            if n > 0 {
                                RoundedRectangle(cornerRadius: 3)
                                    .fill(lv.color)
                                    .frame(width: max(2, geo.size.width * CGFloat(n) / CGFloat(total) - 2))
                            }
                        }
                    }
                }
                .frame(height: 14)
                HStack(spacing: 14) {
                    ForEach(order, id: \.self) { lv in
                        let n = dist[lv] ?? 0
                        HStack(spacing: 4) {
                            Circle().fill(lv.color).frame(width: 7, height: 7)
                            Text("\(lv.label) \(n) 天 (\(total > 0 ? Int((Double(n) / Double(total) * 100).rounded()) : 0)%)")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                Text(distributionHint(dist, total)).font(.caption).foregroundStyle(.secondary)
            } else {
                Text("沒有足夠資料").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func distributionHint(_ dist: [StressLevel: Int], _ total: Int) -> String {
        let high = Double((dist[.tense] ?? 0) + (dist[.high] ?? 0)) / Double(max(1, total))
        if high >= 0.5 { return "超過一半的日子處於緊繃或高壓，身體正在累積疲勞，試著每週安排兩天完全休息。" }
        if high >= 0.25 { return "約四分之一的日子壓力偏高，留意這些日子的共同點（睡眠、工作、飲酒）。" }
        return "大多數日子壓力都在可控範圍，繼續保持。"
    }

    // MARK: HRV

    private func hrvCard(_ days: [ScoredDay]) -> some View {
        let line = days.filter { $0.hrv.isFinite }.map { DatePoint(date: $0.date, value: $0.hrv) }
        let band = days.compactMap { d -> BandPoint? in
            guard let s = d.hrvStatus else { return nil }
            return BandPoint(date: d.date, low: s.low, high: s.high)
        }
        let status = days.last?.hrvStatus
        return Card(title: "HRV 趨勢") {
            Chart {
                ForEach(band) { b in
                    AreaMark(x: .value("日期", b.date, unit: .day), yStart: .value("低", b.low), yEnd: .value("高", b.high))
                        .foregroundStyle(Color.blue.opacity(0.12))
                        .interpolationMethod(.monotone)
                }
                ForEach(line) { p in
                    LineMark(x: .value("日期", p.date, unit: .day), y: .value("HRV", p.value))
                        .foregroundStyle(Color.blue)
                        .interpolationMethod(.monotone)
                    PointMark(x: .value("日期", p.date, unit: .day), y: .value("HRV", p.value))
                        .foregroundStyle(Color.blue)
                        .symbolSize(18)
                }
            }
            .chartXAxis { AxisMarks(values: .automatic(desiredCount: 5)) { _ in AxisValueLabel(format: .dateTime.month().day()) } }
            .frame(height: 180)
            if let s = status {
                Text(hrvText(s)).font(.caption).foregroundStyle(.secondary)
            } else {
                Text("藍色區間是你的個人正常範圍（基準 ± 離散度）。").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func hrvText(_ s: HRVStatus) -> String {
        let pct = Int(((s.ratio - 1) * 100).rounded())
        switch s.trend {
        case .up: return "近 7 天平均 \(Fmt.int(s.recent)) ms，比基準高 \(pct)%。恢復良好，可承受較高訓練量。"
        case .down: return "近 7 天平均 \(Fmt.int(s.recent)) ms，比基準低 \(abs(pct))%。身體可能在累積壓力或正在生病，放慢腳步。"
        case .stable: return "近 7 天平均 \(Fmt.int(s.recent)) ms，與基準 \(Fmt.int(s.baseline)) ms 相近，狀態穩定。"
        }
    }

    // MARK: Resting HR

    private func rhrCard(_ days: [ScoredDay]) -> some View {
        let line = days.filter { $0.restingHR.isFinite }.map { DatePoint(date: $0.date, value: $0.restingHR) }
        let base = days.filter { $0.rhrBaseline.isFinite }.map { DatePoint(date: $0.date, value: $0.rhrBaseline) }
        let latest = days.last
        return Card(title: "靜息心率") {
            Chart {
                ForEach(base) { p in
                    LineMark(x: .value("日期", p.date, unit: .day), y: .value("基準", p.value), series: .value("系列", "基準"))
                        .foregroundStyle(Color.gray)
                        .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                }
                ForEach(line) { p in
                    LineMark(x: .value("日期", p.date, unit: .day), y: .value("bpm", p.value), series: .value("系列", "靜息心率"))
                        .foregroundStyle(Color.pink)
                        .interpolationMethod(.monotone)
                    PointMark(x: .value("日期", p.date, unit: .day), y: .value("bpm", p.value))
                        .foregroundStyle(Color.pink)
                        .symbolSize(18)
                }
            }
            .chartYScale(domain: .automatic(includesZero: false))
            .chartXAxis { AxisMarks(values: .automatic(desiredCount: 5)) { _ in AxisValueLabel(format: .dateTime.month().day()) } }
            .frame(height: 160)
            if let d = latest, d.restingHR.isFinite, d.rhrBaseline.isFinite {
                Text("最新 \(Fmt.int(d.restingHR)) bpm，基準 \(Fmt.int(d.rhrBaseline)) bpm。靜息心率持續高於基準 5 bpm 以上通常代表疲勞、脫水或生病前兆。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Daytime load

    private func awakeCard(_ days: [ScoredDay]) -> some View {
        let points = days.filter { $0.awakeStress.isFinite }.map { DatePoint(date: $0.date, value: $0.awakeStress) }
        return Card(title: "日間即時壓力（清醒時段平均）") {
            if points.isEmpty {
                Text("沒有逐小時心率資料。").font(.caption).foregroundStyle(.secondary)
            } else {
                Chart(points) { p in
                    BarMark(x: .value("日期", p.date, unit: .day), y: .value("壓力", p.value))
                        .foregroundStyle(stressColor(p.value).opacity(0.85))
                        .cornerRadius(3)
                }
                .chartYScale(domain: 0...100)
                .chartXAxis { AxisMarks(values: .automatic(desiredCount: 5)) { _ in AxisValueLabel(format: .dateTime.month().day()) } }
                .frame(height: 150)
                Text("由每小時心率相對靜息心率估算，反映白天的身體負荷，不含運動時段。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
