import SwiftUI

/// Observes user input in the underlying macOS 14 scroll view. Content growth
/// and programmatic scrolls do not turn following off or resume a paused reader.
struct ThreadScrollObserver: NSViewRepresentable {
    var userScrolled: (Double) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(userScrolled: userScrolled) }

    func makeNSView(context: Context) -> NSView {
        let view = ProbeView()
        view.attach = { [weak coordinator = context.coordinator] scrollView in
            coordinator?.attach(to: scrollView)
        }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        context.coordinator.userScrolled = userScrolled
        if let scrollView = view.enclosingScrollView {
            context.coordinator.attach(to: scrollView)
        }
    }

    static func dismantleNSView(_ view: NSView, coordinator: Coordinator) {
        coordinator.detach()
    }

    private final class ProbeView: NSView {
        var attach: ((NSScrollView) -> Void)?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let enclosingScrollView { attach?(enclosingScrollView) }
        }
        override func viewDidMoveToSuperview() {
            super.viewDidMoveToSuperview()
            if let enclosingScrollView { attach?(enclosingScrollView) }
        }
    }

    @MainActor
    final class Coordinator {
        var userScrolled: (Double) -> Void
        private weak var scrollView: NSScrollView?
        private var liveScrollObserver: NSObjectProtocol?
        private var eventMonitor: Any?

        init(userScrolled: @escaping (Double) -> Void) {
            self.userScrolled = userScrolled
        }

        func attach(to scrollView: NSScrollView) {
            guard self.scrollView !== scrollView else { return }
            detach()
            self.scrollView = scrollView
            liveScrollObserver = NotificationCenter.default.addObserver(
                forName: NSScrollView.didLiveScrollNotification, object: scrollView, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.reportPosition() }
            }
            eventMonitor = NSEvent.addLocalMonitorForEvents(
                matching: [.scrollWheel, .keyDown, .leftMouseDown, .leftMouseDragged, .leftMouseUp]
            ) { [weak self] event in
                self?.observe(event)
                return event
            }
        }

        private func observe(_ event: NSEvent) {
            guard let scrollView, event.window === scrollView.window else { return }
            if event.type == .keyDown {
                guard let responder = scrollView.window?.firstResponder as? NSView,
                      responder.isDescendant(of: scrollView) else { return }
            } else {
                let point = scrollView.convert(event.locationInWindow, from: nil)
                guard scrollView.bounds.contains(point) else { return }
            }
            let previousBounds = scrollView.contentView.bounds
            Task { @MainActor [weak self, weak scrollView] in
                await Task.yield()
                if let scrollView, scrollView.contentView.bounds != previousBounds {
                    self?.reportPosition()
                }
            }
        }

        private func reportPosition() {
            guard let scrollView, let document = scrollView.documentView else { return }
            let viewport = scrollView.contentView.bounds
            let distance = document.isFlipped
                ? document.bounds.maxY - viewport.maxY
                : viewport.minY - document.bounds.minY
            userScrolled(max(0, distance))
        }

        func detach() {
            if let liveScrollObserver { NotificationCenter.default.removeObserver(liveScrollObserver) }
            if let eventMonitor { NSEvent.removeMonitor(eventMonitor) }
            liveScrollObserver = nil
            eventMonitor = nil
            scrollView = nil
        }
    }
}
