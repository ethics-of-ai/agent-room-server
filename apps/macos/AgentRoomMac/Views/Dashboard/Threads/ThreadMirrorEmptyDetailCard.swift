import SwiftUI

struct ThreadMirrorEmptyDetailCard: View {
    var body: some View {
        ContentUnavailableView(
            "Select a thread",
            systemImage: "sidebar.leading",
            description: Text("Choose a backend session to inspect its conversation, runner details, and recent activity.")
        )
        .frame(maxWidth: .infinity, minHeight: 520)
        .cardBackground()
    }
}
