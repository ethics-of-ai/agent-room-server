import SwiftUI

struct MenuBarStatusView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MenuBarHeader()
                .padding(.horizontal, 14)
                .padding(.top, 14)
                .padding(.bottom, 12)

            Divider()

            MenuBarActions()
                .padding(.horizontal, 6)
                .padding(.vertical, 6)

            Divider()

            MenuBarFooter()
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
        }
        .frame(width: 296)
    }
}
