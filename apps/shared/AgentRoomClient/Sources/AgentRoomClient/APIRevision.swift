import Foundation

public struct APIRevision: Comparable, Hashable, RawRepresentable, Sendable {
    public let rawValue: String

    public init?(rawValue: String) {
        let scalars = Array(rawValue.unicodeScalars)
        guard scalars.count == 10,
              scalars[4].value == 45,
              scalars[7].value == 45,
              scalars.enumerated().allSatisfy({ index, scalar in
                  index == 4 || index == 7 || (48...57).contains(scalar.value)
              }),
              let year = Int(rawValue.prefix(4)),
              let month = Int(rawValue.dropFirst(5).prefix(2)),
              let day = Int(rawValue.suffix(2)),
              (1...12).contains(month),
              (1...Self.days(in: month, year: year)).contains(day) else {
            return nil
        }
        self.rawValue = rawValue
    }

    public static func < (lhs: APIRevision, rhs: APIRevision) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    private static func days(in month: Int, year: Int) -> Int {
        switch month {
        case 2:
            let leapYear = year.isMultiple(of: 400) || (year.isMultiple(of: 4) && !year.isMultiple(of: 100))
            return leapYear ? 29 : 28
        case 4, 6, 9, 11:
            return 30
        default:
            return 31
        }
    }
}
