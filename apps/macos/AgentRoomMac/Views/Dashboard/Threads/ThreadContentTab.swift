import Foundation

enum ThreadContentTab: String, CaseIterable, Identifiable {
    case transcript, events
    var id: Self { self }
    var title: String { rawValue.capitalized }
}
