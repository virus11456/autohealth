import SwiftUI

struct TodayView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var settings: AppSettings
    @State private var showBreathing = false
    @State private var showWhy = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    if let day = model.selected {
                        dateHeader(day)
                        if model.looksEmpty { emptyHint }
                        stressCard(day)
                        batteryCard(day)
                        metricsGrid(day)
                        timelineCard(day)
                        alertsSection(day)
                        sleepCard(day)
                        activityCard(day)
                        breatheButton
                        disclaimer
                    } else if model.isRefreshing {
                        ProgressView("讀取健康資料…").padding(.top, 80)
                    } else {
                        emptyHint
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("今日")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await model.refresh(reason: .manual) }
                    } label: {
                        if model.isRefreshing { ProgressView() } else { Image(systemName: "arrow.clockwise") }
                    }
                    .disabled(model.isRefreshing)
                }
            }
            .refreshable { await model.refresh(reason: .manual) }
            .sheet(isPresented: $showBreathing) { BreathingView() }
        }
    }

    // MARK: Sections

    private func dateHeader(_ day: ScoredDay) -> some View {
        HStack {
            Button(action: model.goBack) { Image(systemName: "chevron.left") }
                .disabled(!model.canGoBack)
            Spacer()
            VStack(spacing: 2) {
                Text(Fmt.day(day.date)).font(.headline)
                if model.isLatest(day) {
                    Text("今天").font(.caption).foregroundStyle(.secondary)
                } else {
                    Button("回到今天") { model.goToday() }.font(.caption)
                }
            }
            Spacer()
            Button(action: model.goForward) { Image(systemName: "chevron.right") }
                .disabled(!model.canGoForward)
        }
        .padding(.top, 4)
    }

    private var emptyHint: some View {
        Card(title: "還沒有可用的資料") {
            Text("請確認：\n1. 已在「健康」App → 分享 → App 允許 AutoHealth 讀取心率、HRV、睡眠與步數。\n2. Apple Watch 已配對並戴著睡覺。\n3. 第一次讀取可能需要幾秒，請下拉重新整理。")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func summary(_ day: ScoredDay) -> String {
        switch day.level {
        case .relaxed: return "身體處於放鬆狀態，適合安排需要專注或高強度的事。"
        case .balanced: return "壓力在正常範圍，維持目前的節奏就好。"
        case .tense: return "壓力偏高，今天留一些空檔喘口氣。"
        case .high: return "壓力明顯偏高，建議減少刺激、早點休息。"
        case .none: return "還沒有足夠資料。戴上 Apple Watch 累積幾天後，就會開始計算你的個人基準。"
        }
    }

    private func stressCard(_ day: ScoredDay) -> some View {
        Card {
            HStack(spacing: 20) {
                ScoreRing(value: day.stress, color: day.level.color, size: 120, lineWidth: 12,
                          label: Fmt.int(day.stress), sub: "壓力分數")
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(day.level.emoji) \(day.level.label)").font(.title2.bold())
                    Text(summary(day)).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            if !day.components.isEmpty {
                DisclosureGroup("為什麼是這個分數？", isExpanded: $showWhy) {
                    VStack(spacing: 8) {
                        ForEach(day.components) { c in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(c.label).font(.subheadline)
                                    Text(c.text).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(Fmt.signed(c.value))
                                    .font(.subheadline.monospacedDigit().bold())
                                    .foregroundStyle(c.value > 0 ? .red : .green)
                            }
                        }
                        Text("從基準 45 分開始加減：HRV 愈低、靜息心率愈高、日間心率負荷愈大、前晚睡得愈差，分數愈高。")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    .padding(.top, 6)
                }
                .font(.subheadline)
            }
        }
    }

    private func batteryCard(_ day: ScoredDay) -> some View {
        Card {
            HStack(spacing: 16) {
                ScoreRing(value: Double(day.battery.now), color: .battery, size: 84, lineWidth: 9,
                          label: "\(day.battery.now)", sub: "%")
                VStack(alignment: .leading, spacing: 4) {
                    Text("Body Battery").font(.headline)
                    Text("起床 \(day.battery.wake)% · 最低 \(day.battery.low)% · 最高 \(day.battery.high)%")
                        .font(.caption).foregroundStyle(.secondary)
                    Text(batteryHint(day)).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            BatteryCurveChart(day: day)
        }
    }

    private func batteryHint(_ day: ScoredDay) -> String {
        if day.battery.now >= 70 { return "能量充足，可以放心安排挑戰。" }
        if day.battery.now >= 40 { return "能量尚可，注意別把事情全排在同一天。" }
        return "能量偏低，今晚早點休息讓身體充電。"
    }

    private func metricsGrid(_ day: ScoredDay) -> some View {
        let columns = [GridItem(.flexible()), GridItem(.flexible())]
        return LazyVGrid(columns: columns, spacing: 10) {
            MetricTile(title: "恢復分數", value: Fmt.int(day.recovery), unit: "/100",
                       sub: recoveryHint(day.recovery), color: scoreColor(day.recovery))
            MetricTile(title: "HRV", value: Fmt.int(day.hrv), unit: "ms",
                       sub: hrvHint(day), color: day.hrvStatus?.trend == .down ? .orange : .blue)
            MetricTile(title: "靜息心率", value: Fmt.int(day.restingHR), unit: "bpm",
                       sub: day.rhrBaseline.isFinite ? "基準 \(Fmt.int(day.rhrBaseline)) bpm" : "尚無基準",
                       color: (day.zRhr.isFinite && day.zRhr > 1.5) ? .red : .pink)
            if day.metrics.spo2.isFinite {
                MetricTile(title: "血氧", value: Fmt.one(day.metrics.spo2), unit: "%",
                           sub: day.metrics.spo2SleepMin.isFinite ? "睡眠最低 \(Fmt.one(day.metrics.spo2SleepMin))%" : nil,
                           color: .cyan)
            } else {
                MetricTile(title: "呼吸頻率", value: Fmt.one(day.metrics.respiratoryRate), unit: "次/分", color: .cyan)
            }
        }
    }

    private func recoveryHint(_ r: Double) -> String {
        guard r.isFinite else { return "尚無資料" }
        if r >= 75 { return "可以全力以赴" }
        if r >= 50 { return "適度活動" }
        return "建議休息"
    }

    private func hrvHint(_ day: ScoredDay) -> String {
        guard let s = day.hrvStatus else { return "累積資料中" }
        let trend: String
        switch s.trend {
        case .up: trend = "↑ 高於基準"
        case .down: trend = "↓ 低於基準"
        case .stable: trend = "→ 穩定"
        }
        return "基準 \(Fmt.int(s.baseline)) · \(trend)"
    }

    private func timelineCard(_ day: ScoredDay) -> some View {
        Card(title: "即時壓力") {
            if day.hasIntraday {
                StressTimelineChart(slots: day.intraday)
                TimelineLegend()
                if day.awakeStress.isFinite {
                    Text("清醒時段平均 \(Fmt.int(day.awakeStress))。以每小時心率相對靜息心率估算，運動時段不計入。")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            } else {
                Text("這一天沒有逐小時心率資料。").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func alertsSection(_ day: ScoredDay) -> some View {
        let alerts = ScoringEngine.alerts(for: day, previous: model.previous(of: day),
                                          settings: settings.scoring, isLatest: model.isLatest(day))
        if !alerts.isEmpty {
            Card(title: "今日提醒") {
                VStack(spacing: 8) {
                    ForEach(alerts) { a in
                        AlertCard(alert: a) { showBreathing = true }
                    }
                }
            }
        }
    }

    private func sleepCard(_ day: ScoredDay) -> some View {
        Card(title: "昨晚睡眠") {
            if let s = day.metrics.sleep {
                HStack(spacing: 16) {
                    ScoreRing(value: day.sleep.score, color: scoreColor(day.sleep.score), size: 76, lineWidth: 8,
                              label: Fmt.int(day.sleep.score), sub: "分")
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(Fmt.one(s.hours)) 小時").font(.title3.bold())
                        Text("\(Fmt.time(s.start)) 就寢 · \(Fmt.time(s.end)) 起床").font(.caption).foregroundStyle(.secondary)
                        if s.efficiency.isFinite {
                            Text("效率 \(Fmt.int(s.efficiency * 100))%").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                }
                StageBar(sleep: s)
            } else {
                Text("沒有睡眠紀錄。").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func activityCard(_ day: ScoredDay) -> some View {
        let m = day.metrics
        return Card(title: "活動") {
            HStack(spacing: 16) {
                ScoreRing(value: m.steps, maximum: settings.stepsGoal, color: .green, size: 76, lineWidth: 8,
                          label: Fmt.thousands(m.steps), sub: "步")
                VStack(alignment: .leading, spacing: 4) {
                    Text("目標 \(Int(settings.stepsGoal).formatted()) 步").font(.subheadline)
                    Text("活動消耗 \(Fmt.int(m.activeEnergy)) kcal · \(Fmt.one(m.distanceKm)) km")
                        .font(.caption).foregroundStyle(.secondary)
                    if !m.workouts.isEmpty {
                        Text(m.workouts.map { "\($0.activityName) \(Int($0.durationMinutes.rounded())) 分" }.joined(separator: "、"))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }

    private var breatheButton: some View {
        Button {
            showBreathing = true
        } label: {
            Label("開始 3 分鐘呼吸練習", systemImage: "wind")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
    }

    private var disclaimer: some View {
        Text("AutoHealth 不是醫療器材，分數為生活參考，不構成診斷或醫療建議。持續性異常請諮詢醫師。")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.top, 4)
    }
}
