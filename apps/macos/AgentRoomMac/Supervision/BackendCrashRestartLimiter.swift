import Foundation

struct BackendCrashRestartLimiter: Equatable {
    let maxAttempts: Int
    let windowSeconds: TimeInterval
    private var crashTimes: [Date] = []

    init(maxAttempts: Int, windowSeconds: TimeInterval) {
        self.maxAttempts = max(0, maxAttempts)
        self.windowSeconds = max(1, windowSeconds)
    }

    mutating func recordCrashAndShouldRestart(at date: Date = Date()) -> Bool {
        let windowStart = date.addingTimeInterval(-windowSeconds)
        crashTimes = crashTimes.filter { $0 >= windowStart }
        guard crashTimes.count < maxAttempts else {
            return false
        }
        crashTimes.append(date)
        return true
    }

    mutating func reset() {
        crashTimes.removeAll()
    }
}
