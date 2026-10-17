import Foundation

/// Small, dependency-free statistics helpers shared by the scoring engine.
/// Missing values are represented as `Double.nan` throughout, mirroring the
/// web implementation in `docs/scoring.js` so both stay numerically identical.
enum Stats {
    static func finite(_ values: [Double]) -> [Double] {
        values.filter { $0.isFinite }
    }

    static func mean(_ values: [Double]) -> Double {
        let f = finite(values)
        guard !f.isEmpty else { return .nan }
        return f.reduce(0, +) / Double(f.count)
    }

    static func median(_ values: [Double]) -> Double {
        let f = finite(values).sorted()
        guard !f.isEmpty else { return .nan }
        let m = f.count / 2
        return f.count % 2 == 1 ? f[m] : (f[m - 1] + f[m]) / 2
    }

    /// Median absolute deviation scaled to be comparable with a standard deviation.
    static func mad(_ values: [Double], median med: Double = .nan) -> Double {
        let f = finite(values)
        guard f.count >= 4 else { return .nan }
        let m = med.isFinite ? med : median(f)
        return 1.4826 * median(f.map { abs($0 - m) })
    }

    static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double {
        max(lo, min(hi, v))
    }

    /// Piecewise-linear interpolation through points sorted by x.
    static func piecewise(_ x: Double, _ pts: [(Double, Double)]) -> Double {
        guard let first = pts.first, let last = pts.last else { return .nan }
        if x <= first.0 { return first.1 }
        for i in 1..<pts.count where x <= pts[i].0 {
            let (x0, y0) = pts[i - 1]
            let (x1, y1) = pts[i]
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
        }
        return last.1
    }

    struct Baseline {
        var median: Double
        var spread: Double
        var count: Int
        var bootstrap: Bool
    }

    /// Median / spread of the trailing `window` values before index `i`
    /// (excluding `i`). Falls back to a wider window while history is short.
    static func trailingBaseline(_ values: [Double], index i: Int, window: Int, minObs: Int = 5) -> Baseline {
        let lo = max(0, i - window)
        let slice = Array(values[lo..<i])
        let f = finite(slice)
        if f.count < minObs {
            let upper = min(values.count, max(i + 1, window))
            let wide = finite(Array(values[0..<upper]))
            if wide.count < 3 { return Baseline(median: .nan, spread: .nan, count: wide.count, bootstrap: true) }
            return Baseline(median: median(wide), spread: mad(wide), count: wide.count, bootstrap: true)
        }
        let med = median(f)
        return Baseline(median: med, spread: mad(f, median: med), count: f.count, bootstrap: false)
    }

    /// Minutes after 18:00 for a "HH:mm" clock string (bedtime convention).
    static func clockToOffset(_ hhmm: String) -> Double {
        let parts = hhmm.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]) else { return 330 }
        var mins = h * 60 + m - 18 * 60
        if mins < 0 { mins += 24 * 60 }
        return Double(mins)
    }

    /// Inverse of `clockToOffset`.
    static func offsetToClock(_ offset: Double) -> String {
        guard offset.isFinite else { return "—" }
        var mins = Int(offset.rounded()) + 18 * 60
        mins = ((mins % 1440) + 1440) % 1440
        return String(format: "%02d:%02d", mins / 60, mins % 60)
    }
}

extension Calendar {
    /// Local-day key used throughout: midnight of the given date.
    func dayKey(_ date: Date) -> Date { startOfDay(for: date) }

    func addingDays(_ n: Int, to date: Date) -> Date {
        self.date(byAdding: .day, value: n, to: date) ?? date
    }
}
