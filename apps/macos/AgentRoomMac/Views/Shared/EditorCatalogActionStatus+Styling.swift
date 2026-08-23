import SwiftUI

extension EditorCatalogActionStatus {
    var style: StatusStyle {
        switch self {
        case .working:
            StatusStyle(systemImage: "arrow.triangle.2.circlepath", tint: .secondary)
        case .success:
            StatusStyle(systemImage: "checkmark.circle.fill", tint: .green)
        case .failure:
            StatusStyle(systemImage: "xmark.octagon.fill", tint: .red)
        }
    }
}
