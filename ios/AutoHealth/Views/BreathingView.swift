import SwiftUI

/// Guided breathing (mindfulness) exercise with an expanding/contracting circle.
struct BreathingView: View {
    @Environment(\.dismiss) private var dismiss

    enum Pattern: String, CaseIterable, Identifiable {
        case coherent = "共振 5.5-5.5"
        case box = "箱式 4-4-4-4"
        case relax = "放鬆 4-7-8"
        var id: String { rawValue }

        var phases: [(String, Double)] {
            switch self {
            case .coherent: return [("吸氣", 5.5), ("吐氣", 5.5)]
            case .box: return [("吸氣", 4), ("屏息", 4), ("吐氣", 4), ("屏息", 4)]
            case .relax: return [("吸氣", 4), ("屏息", 7), ("吐氣", 8)]
            }
        }

        var description: String {
            switch self {
            case .coherent: return "每分鐘約 5.5 次，提升 HRV 的經典節奏。"
            case .box: return "吸、停、吐、停各 4 秒，穩定注意力。"
            case .relax: return "延長吐氣，啟動副交感神經，適合睡前。"
            }
        }

        var cycle: Double { phases.reduce(0) { $0 + $1.1 } }
    }

    @State private var pattern: Pattern = .coherent
    @State private var minutes = 3
    @State private var startedAt: Date?
    @State private var now = Date()
    @State private var finished = false

    private let timer = Timer.publish(every: 0.05, on: .main, in: .common).autoconnect()

    private var total: Double { Double(minutes * 60) }
    private var elapsed: Double { startedAt.map { now.timeIntervalSince($0) } ?? 0 }
    private var remaining: Double { max(0, total - elapsed) }

    private var phaseInfo: (name: String, secondsLeft: Int, scale: CGFloat) {
        let t = elapsed.truncatingRemainder(dividingBy: pattern.cycle)
        var acc = 0.0
        var index = 0
        var phase = pattern.phases[0]
        var phaseT = t
        for (i, p) in pattern.phases.enumerated() {
            if t < acc + p.1 { phase = p; phaseT = t - acc; index = i; break }
            acc += p.1
        }
        let prog = phaseT / phase.1
        let scale: CGFloat
        if phase.0 == "吸氣" { scale = 0.55 + 0.45 * CGFloat(prog) }
        else if phase.0 == "吐氣" { scale = 1 - 0.45 * CGFloat(prog) }
        else {
            // hold: stay where the previous phase ended
            let prev = pattern.phases[(index + pattern.phases.count - 1) % pattern.phases.count]
            scale = prev.0 == "吸氣" ? 1 : 0.55
        }
        return (phase.0, Int(ceil(phase.1 - phaseT)), scale)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                if startedAt == nil && !finished {
                    setup
                } else if finished {
                    done
                } else {
                    session
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(.systemGroupedBackground))
            .navigationTitle("呼吸練習")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("關閉") { dismiss() } }
            }
            .onReceive(timer) { t in
                now = t
                if startedAt != nil, remaining <= 0, !finished {
                    finished = true
                    startedAt = nil
                }
            }
        }
    }

    private var setup: some View {
        VStack(spacing: 20) {
            Image(systemName: "wind").font(.system(size: 48)).foregroundStyle(.teal)
            Picker("模式", selection: $pattern) {
                ForEach(Pattern.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            Text(pattern.description).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Picker("長度", selection: $minutes) {
                Text("1 分鐘").tag(1)
                Text("3 分鐘").tag(3)
                Text("5 分鐘").tag(5)
            }
            .pickerStyle(.segmented)
            Button {
                finished = false
                startedAt = Date()
            } label: {
                Label("開始", systemImage: "play.fill").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            Text("找個舒服的姿勢，跟著圓圈的大小呼吸。")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var session: some View {
        let info = phaseInfo
        return VStack(spacing: 28) {
            Spacer()
            ZStack {
                Circle().fill(Color.teal.opacity(0.12)).frame(width: 260, height: 260)
                Circle()
                    .fill(LinearGradient(colors: [.teal, .blue], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 240 * info.scale, height: 240 * info.scale)
                    .animation(.linear(duration: 0.05), value: info.scale)
                VStack(spacing: 4) {
                    Text(info.name).font(.title.bold()).foregroundStyle(.white)
                    Text("\(info.secondsLeft)").font(.title3.monospacedDigit()).foregroundStyle(.white.opacity(0.9))
                }
            }
            Text(timeString(remaining)).font(.title2.monospacedDigit()).foregroundStyle(.secondary)
            Spacer()
            Button("結束") {
                finished = true
                startedAt = nil
            }
            .buttonStyle(.bordered)
        }
    }

    private var done: some View {
        VStack(spacing: 16) {
            Image(systemName: "checkmark.circle.fill").font(.system(size: 56)).foregroundStyle(.green)
            Text("完成").font(.title.bold())
            Text("給自己幾秒鐘，感受一下身體現在的狀態。").foregroundStyle(.secondary)
            Button("再做一次") { finished = false }
                .buttonStyle(.bordered)
            Button("關閉") { dismiss() }
                .buttonStyle(.borderedProminent)
        }
    }

    private func timeString(_ s: Double) -> String {
        let t = Int(s.rounded())
        return String(format: "%d:%02d", t / 60, t % 60)
    }
}
