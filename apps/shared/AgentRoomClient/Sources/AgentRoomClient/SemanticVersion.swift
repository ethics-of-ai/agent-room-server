import Foundation

public struct SemanticVersion: Comparable, Hashable, Sendable {
    public let rawValue: String

    private let core: [String]
    private let prerelease: [Identifier]?

    public init?(rawValue: String) {
        guard !rawValue.isEmpty,
              rawValue == rawValue.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return nil
        }

        let buildParts = rawValue.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)
        guard buildParts.count <= 2,
              buildParts.count == 1 || Self.validIdentifiers(buildParts[1], numericLeadingZeroAllowed: true) else {
            return nil
        }

        let precedenceParts = buildParts[0].split(
            separator: "-",
            maxSplits: 1,
            omittingEmptySubsequences: false
        )
        let core = precedenceParts[0].split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard core.count == 3,
              core.allSatisfy(Self.validCoreNumber) else {
            return nil
        }

        let prerelease: [Identifier]?
        if precedenceParts.count == 2 {
            let rawPrerelease = precedenceParts[1]
            guard Self.validIdentifiers(rawPrerelease, numericLeadingZeroAllowed: false) else {
                return nil
            }
            prerelease = rawPrerelease.split(separator: ".").map { component in
                let value = String(component)
                return Self.isNumeric(value) ? .numeric(value) : .text(value)
            }
        } else {
            prerelease = nil
        }

        self.rawValue = rawValue
        self.core = core
        self.prerelease = prerelease
    }

    public static func < (lhs: SemanticVersion, rhs: SemanticVersion) -> Bool {
        for (left, right) in zip(lhs.core, rhs.core) where left != right {
            return compareNumeric(left, right) == .orderedAscending
        }

        switch (lhs.prerelease, rhs.prerelease) {
        case (nil, nil):
            return false
        case (nil, .some):
            return false
        case (.some, nil):
            return true
        case let (.some(left), .some(right)):
            for index in 0..<min(left.count, right.count) where left[index] != right[index] {
                return left[index] < right[index]
            }
            return left.count < right.count
        }
    }

    public static func == (lhs: SemanticVersion, rhs: SemanticVersion) -> Bool {
        lhs.core == rhs.core && lhs.prerelease == rhs.prerelease
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(core)
        hasher.combine(prerelease)
    }

    private static func validCoreNumber(_ value: String) -> Bool {
        isNumeric(value) && (value == "0" || !value.hasPrefix("0"))
    }

    private static func validIdentifiers(
        _ value: Substring,
        numericLeadingZeroAllowed: Bool
    ) -> Bool {
        let identifiers = value.split(separator: ".", omittingEmptySubsequences: false)
        guard !identifiers.isEmpty else { return false }

        return identifiers.allSatisfy { identifier in
            guard !identifier.isEmpty,
                  identifier.unicodeScalars.allSatisfy(Self.isIdentifierScalar) else {
                return false
            }
            return numericLeadingZeroAllowed
                || !Self.isNumeric(String(identifier))
                || identifier == "0"
                || !identifier.hasPrefix("0")
        }
    }

    private static func isIdentifierScalar(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 45, 48...57, 65...90, 97...122:
            return true
        default:
            return false
        }
    }

    private static func isNumeric(_ value: String) -> Bool {
        !value.isEmpty && value.unicodeScalars.allSatisfy { (48...57).contains($0.value) }
    }

    private static func compareNumeric(_ lhs: String, _ rhs: String) -> ComparisonResult {
        if lhs.count != rhs.count {
            return lhs.count < rhs.count ? .orderedAscending : .orderedDescending
        }
        if lhs == rhs { return .orderedSame }
        return lhs < rhs ? .orderedAscending : .orderedDescending
    }

    private enum Identifier: Hashable, Comparable, Sendable {
        case numeric(String)
        case text(String)

        static func < (lhs: Identifier, rhs: Identifier) -> Bool {
            switch (lhs, rhs) {
            case let (.numeric(left), .numeric(right)):
                return SemanticVersion.compareNumeric(left, right) == .orderedAscending
            case (.numeric, .text):
                return true
            case (.text, .numeric):
                return false
            case let (.text(left), .text(right)):
                return left < right
            }
        }
    }
}
