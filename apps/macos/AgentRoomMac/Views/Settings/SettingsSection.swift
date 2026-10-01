import Foundation

enum SettingsSection: String, CaseIterable, Identifiable {
    case setup, credentials, runners, models, languages, appearance, advanced

    var id: Self { self }
    var title: String { rawValue.capitalized }
    var systemImage: String {
        switch self {
        case .setup: "wand.and.stars"
        case .credentials: "key.fill"
        case .runners: "cpu"
        case .models: "list.bullet.rectangle"
        case .languages: "curlybraces"
        case .appearance: "circle.lefthalf.filled"
        case .advanced: "slider.horizontal.3"
        }
    }
}
