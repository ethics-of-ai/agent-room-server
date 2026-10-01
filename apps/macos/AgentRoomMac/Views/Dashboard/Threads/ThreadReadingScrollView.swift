import SwiftUI

/// Each mounted instance owns its anchor and following state. Keep both tabs
/// mounted so switching tabs preserves their independent reading positions.
struct ThreadReadingScrollView<Item: Identifiable & Equatable, Row: View>: View where Item.ID == String {
    var items: [Item]
    @ViewBuilder var row: (Item) -> Row
    @State private var reading = ThreadReadingState()
    private let bottomID = "thread-reading-bottom"

    var body: some View {
        ScrollViewReader { proxy in
            VStack(alignment: .leading, spacing: DashboardTheme.elementSpacing) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: DashboardTheme.rowSpacing) {
                        ForEach(items) { item in
                            row(item).id(item.id)
                        }
                        Color.clear.frame(height: 1).id(bottomID)
                    }
                    .scrollTargetLayout()
                    .background(ThreadScrollObserver(userScrolled: observeScroll))
                }
                .scrollPosition(id: reading.isFollowing ? .constant(nil) : $reading.anchorID, anchor: .top)
                .defaultScrollAnchor(.bottom)
                .onChange(of: items) {
                    if reading.contentChanged(retainedIDs: items.map(\.id)) {
                        scrollToLatest(using: proxy)
                    }
                }
                .onAppear { if reading.isFollowing { proxy.scrollTo(bottomID, anchor: .bottom) } }
                .onChange(of: reading.isFollowing) {
                    if reading.isFollowing { scrollToLatest(using: proxy) }
                }

                if !reading.isFollowing {
                    Button("Jump to latest", systemImage: "arrow.down.to.line") {
                        reading.jumpToLatest()
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
        }
    }

    private func scrollToLatest(using proxy: ScrollViewProxy) {
        Task { @MainActor in
            // Let the layout release its paused anchor and place new content.
            await Task.yield()
            guard reading.isFollowing else { return }
            proxy.scrollTo(bottomID, anchor: .bottom)
        }
    }

    private func observeScroll(distance: Double) {
        reading.userScrolled(distanceToBottom: distance)
    }
}
