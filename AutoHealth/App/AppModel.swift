import Foundation
import Combine

/// Single source of truth for the UI: loads HealthKit data, runs the scoring
/// engine, drives notifications.
@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    enum AuthState: Equatable {
        case unknown, unavailable, requesting, ready
        case failed(String)
    }

    enum RefreshReason { case launch, foreground, manual, background, settings }

    @Published var authState: AuthState = .unknown
    @Published private(set) var rawDays: [DailyMetrics] = []
    @Published private(set) var days: [ScoredDay] = []
    @Published var selectedDate: Date?
    @Published var isRefreshing = false
    @Published var lastRefresh: Date?
    @Published var errorMessage: String?

    let settings = AppSettings()
    let health = HealthStore.shared
    let notifications = NotificationService.shared

    private var cancellables = Set<AnyCancellable>()
    private var observersStarted = false
    private var loadedHistoryDays = 0

    private init() {
        settings.objectWillChange
            .debounce(for: .milliseconds(400), scheduler: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self else { return }
                if self.settings.historyDays != self.loadedHistoryDays {
                    Task { await self.refresh(reason: .settings) }
                } else {
                    self.rescore()
                }
            }
            .store(in: &cancellables)
    }

    // MARK: Lifecycle

    func bootstrap() async {
        guard authState == .unknown || authState == .unavailable else { return }
        guard health.isAvailable else { authState = .unavailable; return }
        authState = .requesting
        do {
            try await health.requestAuthorization()
        } catch {
            authState = .failed(error.localizedDescription)
            return
        }
        authState = .ready
        await notifications.requestAuthorization()
        await health.enableBackgroundDelivery()
        startBackgroundObservers()
        await refresh(reason: .launch)
    }

    func retryAuthorization() async {
        authState = .unknown
        await bootstrap()
    }

    /// Safe to call from a background launch (AppDelegate) before any UI exists.
    func startBackgroundObservers() {
        guard !observersStarted, health.isAvailable else { return }
        observersStarted = true
        health.startObserving { [weak self] in
            await self?.refresh(reason: .background)
        }
    }

    func refresh(reason: RefreshReason) async {
        if isRefreshing { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let history = settings.historyDays
            let raw = try await health.fetchDailyMetrics(days: history)
            loadedHistoryDays = history
            rawDays = raw
            rescore()
            lastRefresh = Date()
            errorMessage = nil
            if let latest = days.last {
                await notifications.evaluate(latest: latest, previous: days.dropLast().last,
                                             settings: settings.scoring, enabled: settings.notificationsEnabled)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func rescore() {
        days = ScoringEngine.score(days: rawDays, settings: settings.scoring)
        if let sel = selectedDate, !days.contains(where: { $0.date == sel }) { selectedDate = nil }
    }

    // MARK: Selection helpers

    var latest: ScoredDay? { days.last }

    var selected: ScoredDay? {
        if let d = selectedDate, let s = days.first(where: { $0.date == d }) { return s }
        return days.last
    }

    var selectedIndex: Int? {
        guard let s = selected else { return nil }
        return days.firstIndex { $0.date == s.date }
    }

    var canGoBack: Bool { (selectedIndex ?? 0) > 0 }
    var canGoForward: Bool { if let i = selectedIndex { return i < days.count - 1 } else { return false } }

    func goBack() { if let i = selectedIndex, i > 0 { selectedDate = days[i - 1].date } }
    func goForward() { if let i = selectedIndex, i < days.count - 1 { selectedDate = days[i + 1].date } }
    func goToday() { selectedDate = nil }

    func isLatest(_ day: ScoredDay) -> Bool { day.date == days.last?.date }

    func previous(of day: ScoredDay) -> ScoredDay? {
        guard let i = days.firstIndex(where: { $0.date == day.date }), i > 0 else { return nil }
        return days[i - 1]
    }

    /// Days ending at the selected day for trend charts.
    func window(_ period: ScoringEngine.Period) -> [ScoredDay] {
        guard let end = selectedIndex else { return [] }
        let start = max(0, end - period.days + 1)
        return Array(days[start...end])
    }

    /// Does the data look empty (e.g. permission denied, no Watch)?
    var looksEmpty: Bool {
        !days.isEmpty && !days.contains { $0.hrv.isFinite || $0.restingHR.isFinite || $0.metrics.steps.isFinite }
    }
}
