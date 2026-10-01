import SwiftUI

struct ThreadSelectionPlaceholder: View {
    var isHidden: Bool
    var isUnavailable: Bool
    var clearFilters: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label(isHidden ? "Thread hidden by filters" : isUnavailable ? "Thread unavailable" : "Select a thread",
                  systemImage: "text.bubble")
        } description: {
            Text(isHidden ? "Clear filters to return to the selected thread."
                 : isUnavailable ? "The selected thread is no longer available. Choose another thread."
                 : "Choose a backend session to read its transcript and recent activity.")
        } actions: {
            if isHidden { Button("Clear filters", action: clearFilters) }
        }
    }
}
