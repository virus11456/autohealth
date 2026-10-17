import Foundation
import HealthKit

enum HealthError: LocalizedError {
    case unavailable

    var errorDescription: String? {
        switch self {
        case .unavailable: return "這台裝置沒有「健康」資料（iPad / 模擬器不支援 HealthKit）。"
        }
    }
}

/// Thin async wrapper around HealthKit. Reads only; nothing is written back.
final class HealthStore {
    static let shared = HealthStore()

    let store = HKHealthStore()
    private var observerQueries: [HKObserverQuery] = []

    var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    static let quantityIdentifiers: [HKQuantityTypeIdentifier] = [
        .stepCount, .activeEnergyBurned, .distanceWalkingRunning, .flightsClimbed,
        .heartRate, .restingHeartRate, .heartRateVariabilitySDNN, .oxygenSaturation,
        .respiratoryRate, .vo2Max,
    ]

    private var readTypes: Set<HKObjectType> {
        var set = Set<HKObjectType>()
        for id in Self.quantityIdentifiers { set.insert(HKQuantityType(id)) }
        set.insert(HKCategoryType(.sleepAnalysis))
        set.insert(HKObjectType.workoutType())
        return set
    }

    // MARK: Authorization

    func requestAuthorization() async throws {
        guard isAvailable else { throw HealthError.unavailable }
        let share: Set<HKSampleType> = []
        try await store.requestAuthorization(toShare: share, read: readTypes)
    }

    // MARK: Fetching

    /// Loads the last `days` calendar days (today included) as `DailyMetrics`.
    func fetchDailyMetrics(days: Int) async throws -> [DailyMetrics] {
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        let end = cal.addingDays(1, to: today)
        let start = cal.addingDays(-(max(7, days) - 1), to: today)
        // Sleep attributed to `start` began the evening before.
        let sleepStart = cal.addingDays(-1, to: start)

        async let stepsD = dailyValues(.stepCount, .cumulativeSum, .count(), start, end)
        async let energyD = dailyValues(.activeEnergyBurned, .cumulativeSum, .kilocalorie(), start, end)
        async let distanceD = dailyValues(.distanceWalkingRunning, .cumulativeSum, .meterUnit(with: .kilo), start, end)
        async let flightsD = dailyValues(.flightsClimbed, .cumulativeSum, .count(), start, end)
        async let hrD = dailyValues(.heartRate, .discreteAverage, Self.bpm, start, end)
        async let rhrD = dailyValues(.restingHeartRate, .discreteAverage, Self.bpm, start, end)
        async let hrvD = dailyValues(.heartRateVariabilitySDNN, .discreteAverage, .secondUnit(with: .milli), start, end)
        async let spo2D = dailyValues(.oxygenSaturation, .discreteAverage, .percent(), start, end)
        async let respD = dailyValues(.respiratoryRate, .discreteAverage, Self.bpm, start, end)
        async let vo2D = dailyValues(.vo2Max, .discreteAverage, HKUnit(from: "ml/kg*min"), start, end)

        async let hrH = hourlyStatistics(.heartRate, [.discreteAverage, .discreteMin], start, end)
        async let hrvH = hourlyStatistics(.heartRateVariabilitySDNN, [.discreteAverage], start, end)
        async let stepsH = hourlyStatistics(.stepCount, [.cumulativeSum], start, end)
        async let energyH = hourlyStatistics(.activeEnergyBurned, [.cumulativeSum], start, end)

        async let sleepSamples = fetchSleep(start: sleepStart, end: end)
        async let workoutSamples = fetchWorkouts(start: sleepStart, end: end)
        async let spo2Samples = fetchQuantitySamples(.oxygenSaturation, start: sleepStart, end: end)

        var byDay: [Date: DailyMetrics] = [:]
        var cursor = start
        while cursor < end {
            byDay[cursor] = DailyMetrics(date: cursor)
            cursor = cal.addingDays(1, to: cursor)
        }
        func update(_ day: Date, _ body: (inout DailyMetrics) -> Void) {
            let key = cal.dayKey(day)
            if var m = byDay[key] { body(&m); byDay[key] = m }
        }

        for (d, v) in try await stepsD { update(d) { $0.steps = v } }
        for (d, v) in try await energyD { update(d) { $0.activeEnergy = v } }
        for (d, v) in try await distanceD { update(d) { $0.distanceKm = v } }
        for (d, v) in try await flightsD { update(d) { $0.flights = v } }
        for (d, v) in try await hrD { update(d) { $0.heartRate = v } }
        for (d, v) in try await rhrD { update(d) { $0.restingHeartRate = v } }
        for (d, v) in try await hrvD { update(d) { $0.hrv = v } }
        for (d, v) in try await spo2D { update(d) { $0.spo2 = v * 100 } }
        for (d, v) in try await respD { update(d) { $0.respiratoryRate = v } }
        for (d, v) in try await vo2D { update(d) { $0.vo2Max = v } }

        // Hourly buckets
        func hourly(_ stats: [HKStatistics], _ apply: (inout HourlyMetrics, Int, HKStatistics) -> Void) {
            for s in stats {
                let hour = cal.component(.hour, from: s.startDate)
                update(s.startDate) { m in
                    var h = m.hourly ?? HourlyMetrics()
                    apply(&h, hour, s)
                    m.hourly = h
                }
            }
        }
        let hrStats = try await hrH
        let hrvStats = try await hrvH
        let stepStats = try await stepsH
        let energyStats = try await energyH
        hourly(hrStats) { h, i, s in
            if let v = s.averageQuantity()?.doubleValue(for: Self.bpm) { h.heartRate[i] = v }
            if let v = s.minimumQuantity()?.doubleValue(for: Self.bpm) { h.heartRateMin[i] = v }
        }
        hourly(hrvStats) { h, i, s in
            if let v = s.averageQuantity()?.doubleValue(for: .secondUnit(with: .milli)) { h.hrv[i] = v }
        }
        hourly(stepStats) { h, i, s in
            if let v = s.sumQuantity()?.doubleValue(for: .count()) { h.steps[i] = v }
        }
        hourly(energyStats) { h, i, s in
            if let v = s.sumQuantity()?.doubleValue(for: .kilocalorie()) { h.energy[i] = v }
        }

        // Sleep
        let sleepRaw = try await sleepSamples
        let sleepByDay = Self.buildSleep(sleepRaw)
        for (d, s) in sleepByDay { update(d) { $0.sleep = s } }

        // Lowest SpO2 while asleep
        let spo2Raw = try await spo2Samples
        for sample in spo2Raw {
            let value = sample.quantity.doubleValue(for: .percent()) * 100
            for (d, s) in sleepByDay where s.intervals.contains(where: { $0.contains(sample.startDate) }) {
                update(d) { m in
                    m.spo2SleepMin = m.spo2SleepMin.isFinite ? min(m.spo2SleepMin, value) : value
                }
                break
            }
        }

        // Workouts
        let workoutRaw = try await workoutSamples
        for w in workoutRaw {
            let energy = w.statistics(for: HKQuantityType(.activeEnergyBurned))?.sumQuantity()?.doubleValue(for: .kilocalorie()) ?? .nan
            let summary = WorkoutSummary(id: w.uuid, start: w.startDate, end: w.endDate,
                                         durationMinutes: w.duration / 60,
                                         activityName: Self.activityName(w.workoutActivityType),
                                         energyKcal: energy)
            update(w.startDate) { $0.workouts.append(summary) }
        }

        return byDay.values.sorted { $0.date < $1.date }
    }

    // MARK: Background delivery

    private var observedTypes: [HKSampleType] {
        [HKQuantityType(.heartRateVariabilitySDNN), HKQuantityType(.restingHeartRate),
         HKQuantityType(.heartRate), HKQuantityType(.stepCount), HKCategoryType(.sleepAnalysis)]
    }

    func enableBackgroundDelivery() async {
        for type in observedTypes {
            try? await store.enableBackgroundDelivery(for: type, frequency: .hourly)
        }
    }

    /// Registers observer queries; HealthKit wakes the app (even from the
    /// background) whenever new samples arrive and calls `handler`.
    func startObserving(handler: @escaping @Sendable () async -> Void) {
        for q in observerQueries { store.stop(q) }
        observerQueries.removeAll()
        for type in observedTypes {
            let query = HKObserverQuery(sampleType: type, predicate: nil) { _, completion, error in
                if error != nil { completion(); return }
                Task {
                    await handler()
                    completion()
                }
            }
            store.execute(query)
            observerQueries.append(query)
        }
    }

    // MARK: Query helpers

    private static let bpm = HKUnit.count().unitDivided(by: .minute())

    private func statistics(_ id: HKQuantityTypeIdentifier, options: HKStatisticsOptions,
                            interval: DateComponents, start: Date, end: Date) async throws -> [HKStatistics] {
        let type = HKQuantityType(id)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        let descriptor = HKStatisticsCollectionQueryDescriptor(
            predicate: .quantitySample(type: type, predicate: predicate),
            options: options,
            anchorDate: Calendar.current.startOfDay(for: start),
            intervalComponents: interval)
        let collection = try await descriptor.result(for: store)
        var out: [HKStatistics] = []
        collection.enumerateStatistics(from: start, to: end) { stats, _ in out.append(stats) }
        return out
    }

    private func dailyValues(_ id: HKQuantityTypeIdentifier, _ options: HKStatisticsOptions, _ unit: HKUnit,
                             _ start: Date, _ end: Date) async throws -> [(Date, Double)] {
        let stats = try await statistics(id, options: options, interval: DateComponents(day: 1), start: start, end: end)
        var out: [(Date, Double)] = []
        for s in stats {
            let q = options.contains(.cumulativeSum) ? s.sumQuantity() : s.averageQuantity()
            if let v = q?.doubleValue(for: unit) { out.append((s.startDate, v)) }
        }
        return out
    }

    private func hourlyStatistics(_ id: HKQuantityTypeIdentifier, _ options: HKStatisticsOptions,
                                  _ start: Date, _ end: Date) async throws -> [HKStatistics] {
        try await statistics(id, options: options, interval: DateComponents(hour: 1), start: start, end: end)
    }

    private func fetchSleep(start: Date, end: Date) async throws -> [HKCategorySample] {
        let type = HKCategoryType(.sleepAnalysis)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.categorySample(type: type, predicate: predicate)],
            sortDescriptors: [SortDescriptor(\.startDate)])
        return try await descriptor.result(for: store)
    }

    private func fetchWorkouts(start: Date, end: Date) async throws -> [HKWorkout] {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.workout(predicate)],
            sortDescriptors: [SortDescriptor(\.startDate)])
        return try await descriptor.result(for: store)
    }

    private func fetchQuantitySamples(_ id: HKQuantityTypeIdentifier, start: Date, end: Date) async throws -> [HKQuantitySample] {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.quantitySample(type: HKQuantityType(id), predicate: predicate)],
            sortDescriptors: [SortDescriptor(\.startDate)])
        return try await descriptor.result(for: store)
    }

    // MARK: Sleep aggregation

    /// Groups sleep samples by the local day they ended on. Stage records
    /// (Apple Watch) win over plain in-bed records (iPhone) for the asleep
    /// intervals, mirroring the web aggregator.
    static func buildSleep(_ samples: [HKCategorySample]) -> [Date: SleepSummary] {
        let cal = Calendar.current
        var byDay: [Date: SleepSummary] = [:]
        var inBedIntervals: [Date: [DateInterval]] = [:]
        var asleepIntervals: [Date: [DateInterval]] = [:]

        for s in samples {
            guard let value = HKCategoryValueSleepAnalysis(rawValue: s.value) else { continue }
            let day = cal.dayKey(s.endDate)
            var sum = byDay[day] ?? SleepSummary()
            let minutes = s.endDate.timeIntervalSince(s.startDate) / 60
            let interval = DateInterval(start: s.startDate, end: max(s.startDate, s.endDate))
            switch value {
            case .inBed:
                sum.inBedMinutes += minutes
                inBedIntervals[day, default: []].append(interval)
            case .awake:
                sum.awakeMinutes += minutes
            case .asleepDeep:
                sum.asleepMinutes += minutes; sum.deepMinutes += minutes
                asleepIntervals[day, default: []].append(interval)
            case .asleepREM:
                sum.asleepMinutes += minutes; sum.remMinutes += minutes
                asleepIntervals[day, default: []].append(interval)
            case .asleepCore:
                sum.asleepMinutes += minutes; sum.coreMinutes += minutes
                asleepIntervals[day, default: []].append(interval)
            case .asleepUnspecified:
                sum.asleepMinutes += minutes; sum.coreMinutes += minutes
                asleepIntervals[day, default: []].append(interval)
            @unknown default:
                continue
            }
            if sum.start == nil || s.startDate < sum.start! { sum.start = s.startDate }
            if sum.end == nil || s.endDate > sum.end! { sum.end = s.endDate }
            byDay[day] = sum
        }
        for (day, summary) in byDay {
            var sum = summary
            let list = asleepIntervals[day] ?? inBedIntervals[day] ?? []
            sum.intervals = list.sorted { $0.start < $1.start }
            byDay[day] = sum
        }
        return byDay
    }

    // MARK: Workout names

    static func activityName(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .running: return "跑步"
        case .walking: return "步行"
        case .cycling: return "騎車"
        case .swimming: return "游泳"
        case .yoga: return "瑜伽"
        case .functionalStrengthTraining, .traditionalStrengthTraining: return "重量訓練"
        case .hiking: return "健行"
        case .highIntensityIntervalTraining: return "高強度間歇"
        case .elliptical: return "橢圓機"
        case .rowing: return "划船"
        case .coreTraining: return "核心訓練"
        case .pilates: return "皮拉提斯"
        case .dance, .socialDance, .cardioDance: return "舞蹈"
        case .soccer: return "足球"
        case .basketball: return "籃球"
        case .tennis: return "網球"
        case .badminton: return "羽球"
        case .tableTennis: return "桌球"
        case .stairClimbing: return "爬樓梯"
        case .mindAndBody: return "身心"
        case .cooldown: return "緩和"
        case .flexibility: return "伸展"
        case .mixedCardio: return "混合有氧"
        default: return "運動"
        }
    }
}
