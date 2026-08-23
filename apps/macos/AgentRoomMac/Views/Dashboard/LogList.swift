import SwiftUI

struct LogList: View {
    var rows: [LogRowItem]

    var body: some View {
        DividedVStack(items: rows) { row in
            LogRow(item: row)
        }
    }
}
