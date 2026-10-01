import Foundation
import Observation

@MainActor
@Observable
final class AppAppearanceStore {
    private let defaults: UserDefaults
    private static let preferenceKey = "appAppearance"

    var selection: AppAppearance {
        didSet { defaults.set(selection.rawValue, forKey: Self.preferenceKey) }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        selection = defaults.string(forKey: Self.preferenceKey)
            .flatMap(AppAppearance.init(rawValue:)) ?? .system
    }
}
