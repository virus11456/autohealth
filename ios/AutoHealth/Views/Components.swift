import SwiftUI
import Charts

// MARK: - Theme

extension StressLevel {
    var color: Color {
        switch self {
        case .relaxed: return .green
        case .balanced: return .blue
        case .tense: return .orange
        case .high: return .red
        case .none: return .gray
        }
    }
}

extension Color {
    static let battery = Color.teal
    static let sleepColor = Color.indigo
    static let workoutColor = Color.orange
    static let deepSleep = Color(red: 0.25, green: 0.25, blue: 0.75)
    static let coreSleep = Color(red: 0.45, green: 0.55, blue: 0.95)
    static let remSleep = Color(red: 0.55, green: 0.80, blue: 0.95)
    static let awakeSleep = Color(red: 0.95, green: 0.65, blue: 0.40)
}

func stressColor(_ score: Double) -> Color { StressLevel.from(score).color }

func scoreColor(_ score: Double) -> Color {
    guard score.isFinite else { return .gray }
    if score >= 75 { return .green }
    if score >= 50 { return .blue }
    if score >= 25 { return .orange }
    return .red
}

// MARK: - Formatting

enum Fmt {
    static func int(_ v: Double) -> String { v.isFinite ? String(Int(v.rounded())) : "—" }
    static func one(_ v: Double) -> String { v.isFinite ? String(format: "%.1f", v) : "—" }
    static func signed(_ v: Double) -> String { v.isFinite ? String(format: "%+.0f", v) : "—" }
    static func thousands(_ v: Double) -> String { v.isFinite ? Int(v.rounded()).formatted() : "—" }

    static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "zh_Hant_TW")
        f.dateFormat = "M月d日 EEEE"
        return f
    }()
    static let shortDayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "zh_Hant_TW")
        f.dateFormat = "M/d"
        return f
    }()
    static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "zh_Hant_TW")
        f.dateFormat = "HH:mm"
        return f
    }()

    static func day(_ d: Date) -> String { dayFormatter.string(from: d) }
    static func shortDay(_ d: Date) -> String { shortDayFormatter.string(from: d) }
    static func time(_ d: Date?) -> String { d.map { timeFormatter.string(from: $0) } ?? "—" }
}

// MARK: - Card

struct Card<Content: View>: View {
    var title: String? = nil
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title {
                Text(title).font(.headline)
            }
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

// MARK: - Score ring

struct ScoreRing: View {
    var value: Double
    var maximum: Double = 100
    var color: Color
    var size: CGFloat = 100
    var lineWidth: CGFloat = 10
    var label: String
    var sub: String? = nil

    private var fraction: CGFloat {
        guard value.isFinite, maximum > 0 else { return 0 }
        return CGFloat(min(1, max(0, value / maximum)))
    }

    var body: some View {
        ZStack {
            Circle().stroke(color.opacity(0.15), lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: fraction)
                .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.easeOut(duration: 0.6), value: fraction)
            VStack(spacing: 0) {
                Text(label)
                    .font(.system(size: size * 0.3, weight: .bold, design: .rounded))
                    .monospacedDigit()
                if let sub {
                    Text(sub).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Metric tile

struct MetricTile: View {
    var title: String
    var value: String
    var unit: String? = nil
    var sub: String? = nil
    var color: Color = .accentColor

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value).font(.title2.bold().monospacedDigit()).foregroundStyle(color)
                if let unit { Text(unit).font(.caption).foregroundStyle(.secondary) }
            }
            if let sub {
                Text(sub).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.tertiarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

// MARK: - Alert card

struct AlertCard: View {
    var alert: DailyAlert
    var onBreathe: () -> Void = {}

    private var tint: Color {
        switch alert.kind {
        case .alert: return .red
        case .watch: return .orange
        case .good: return .green
        case .info: return .blue
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(alert.icon).font(.title2)
            VStack(alignment: .leading, spacing: 4) {
                Text(alert.title).font(.subheadline.bold())
                Text(alert.text).font(.caption).foregroundStyle(.secondary)
                if alert.action == .breathe {
                    Button("開始呼吸練習", action: onBreathe)
                        .font(.caption.bold())
                        .buttonStyle(.bordered)
                        .tint(tint)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.08))
        .overlay(alignment: .leading) {
            Rectangle().fill(tint).frame(width: 3)
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

// MARK: - Intraday stress timeline

struct StressTimelineChart: View {
    var slots: [HourSlot]

    private struct Bar: Identifiable {
        var id: Int
        var hour: Int
        var height: Double
        var color: Color
        var opacity: Double
    }

    private var bars: [Bar] {
        slots.map { s -> Bar in
            switch s.state {
            case .sleep:
                return Bar(id: s.hour, hour: s.hour, height: s.stress.isFinite ? max(s.stress, 8) : 15, color: .sleepColor, opacity: 1)
            case .workout:
                return Bar(id: s.hour, hour: s.hour, height: 85, color: .workoutColor, opacity: 1)
            case .awake:
                return Bar(id: s.hour, hour: s.hour, height: s.stress.isFinite ? max(s.stress, 4) : 4,
                           color: s.stress.isFinite ? stressColor(s.stress) : .gray, opacity: 1)
            case .none:
                return Bar(id: s.hour, hour: s.hour, height: 3, color: .gray, opacity: 0.4)
            }
        }
    }

    var body: some View {
        Chart(bars) { b in
            BarMark(x: .value("小時", b.hour), y: .value("壓力", b.height), width: .ratio(0.7))
                .foregroundStyle(b.color.opacity(b.opacity))
                .cornerRadius(3)
        }
        .chartXScale(domain: -0.5...23.5)
        .chartYScale(domain: 0...100)
        .chartXAxis {
            AxisMarks(values: [0, 6, 12, 18, 23]) { value in
                AxisValueLabel {
                    if let h = value.as(Int.self) { Text("\(h)時").font(.caption2) }
                }
            }
        }
        .chartYAxis {
            AxisMarks(values: [0, 25, 50, 75, 100]) { _ in
                AxisGridLine()
                AxisValueLabel()
            }
        }
        .frame(height: 140)
    }
}

struct TimelineLegend: View {
    var body: some View {
        HStack(spacing: 10) {
            legend(.green, "放鬆"); legend(.blue, "平衡"); legend(.orange, "緊繃"); legend(.red, "高壓")
            legend(.sleepColor, "睡眠"); legend(.workoutColor, "運動")
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
    }

    private func legend(_ c: Color, _ t: String) -> some View {
        HStack(spacing: 3) { Circle().fill(c).frame(width: 7, height: 7); Text(t) }
    }
}

// MARK: - Body Battery curve

struct BatteryCurveChart: View {
    var day: ScoredDay

    private struct Point: Identifiable {
        var id: Int
        var hour: Int
        var value: Int
    }

    private var points: [Point] {
        day.battery.curve.enumerated().map { Point(id: $0.offset, hour: $0.offset, value: $0.element) }
    }

    private var sleepHours: [Int] { day.intraday.filter { $0.state == .sleep }.map { $0.hour } }
    private var workoutHours: [Int] { day.intraday.filter { $0.state == .workout }.map { $0.hour } }

    var body: some View {
        Chart {
            ForEach(sleepHours, id: \.self) { h in
                RectangleMark(xStart: .value("起", Double(h) - 0.5), xEnd: .value("迄", Double(h) + 0.5),
                              yStart: .value("低", 0), yEnd: .value("高", 100))
                    .foregroundStyle(Color.sleepColor.opacity(0.10))
            }
            ForEach(workoutHours, id: \.self) { h in
                RectangleMark(xStart: .value("起", Double(h) - 0.5), xEnd: .value("迄", Double(h) + 0.5),
                              yStart: .value("低", 0), yEnd: .value("高", 100))
                    .foregroundStyle(Color.workoutColor.opacity(0.12))
            }
            ForEach(points) { p in
                AreaMark(x: .value("小時", Double(p.hour)), y: .value("電量", p.value))
                    .foregroundStyle(
                        LinearGradient(colors: [Color.battery.opacity(0.35), Color.battery.opacity(0.02)],
                                       startPoint: .top, endPoint: .bottom))
                    .interpolationMethod(.monotone)
                LineMark(x: .value("小時", Double(p.hour)), y: .value("電量", p.value))
                    .foregroundStyle(Color.battery)
                    .lineStyle(StrokeStyle(lineWidth: 2.5))
                    .interpolationMethod(.monotone)
            }
        }
        .chartXScale(domain: 0...23)
        .chartYScale(domain: 0...100)
        .chartXAxis {
            AxisMarks(values: [0, 6, 12, 18, 23]) { value in
                AxisValueLabel {
                    if let h = value.as(Double.self) { Text("\(Int(h))時").font(.caption2) }
                }
            }
        }
        .chartYAxis {
            AxisMarks(values: [0, 50, 100]) { _ in
                AxisGridLine()
                AxisValueLabel()
            }
        }
        .frame(height: 150)
    }
}

// MARK: - Sleep stage bar

struct StageBar: View {
    var sleep: SleepSummary

    private var segments: [(String, Double, Color)] {
        [("深睡", sleep.deepMinutes, .deepSleep), ("核心", sleep.coreMinutes, .coreSleep),
         ("REM", sleep.remMinutes, .remSleep), ("清醒", sleep.awakeMinutes, .awakeSleep)]
            .filter { $0.1 > 0 }
    }

    var body: some View {
        let total = segments.reduce(0) { $0 + $1.1 }
        VStack(alignment: .leading, spacing: 8) {
            if total > 0 {
                GeometryReader { geo in
                    HStack(spacing: 2) {
                        ForEach(Array(segments.enumerated()), id: \.offset) { _, seg in
                            RoundedRectangle(cornerRadius: 3)
                                .fill(seg.2)
                                .frame(width: max(2, geo.size.width * seg.1 / total - 2))
                        }
                    }
                }
                .frame(height: 14)
                HStack(spacing: 12) {
                    ForEach(Array(segments.enumerated()), id: \.offset) { _, seg in
                        HStack(spacing: 4) {
                            Circle().fill(seg.2).frame(width: 7, height: 7)
                            Text("\(seg.0) \(Int(seg.1.rounded())) 分").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                Text("沒有睡眠階段資料（需要 Apple Watch）").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - Period picker

struct PeriodPicker: View {
    @Binding var period: ScoringEngine.Period

    var body: some View {
        Picker("期間", selection: $period) {
            ForEach(ScoringEngine.Period.allCases) { p in
                Text(p.rawValue).tag(p)
            }
        }
        .pickerStyle(.segmented)
    }
}

// MARK: - Simple chart point

struct DatePoint: Identifiable {
    var date: Date
    var value: Double
    var id: Date { date }
}

struct BandPoint: Identifiable {
    var date: Date
    var low: Double
    var high: Double
    var id: Date { date }
}
