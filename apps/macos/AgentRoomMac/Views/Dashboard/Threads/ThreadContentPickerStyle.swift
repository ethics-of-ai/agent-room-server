import SwiftUI

/// Content navigation uses tab semantics on 27 while retaining the supported OS fallback.
struct ThreadContentPickerStyle: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(macOS 27, *) {
            content.pickerStyle(.tabs)
        } else {
            content.pickerStyle(.segmented)
        }
    }
}
