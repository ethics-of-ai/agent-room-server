import SwiftUI

struct DiagnosticsSection: View {
    @Binding var isExporting: Bool
    var exportAction: () -> Void
    var openEndpoint: (String) -> Void

    var body: some View {
        DiagnosticsControlsCard(isExporting: $isExporting, exportAction: exportAction)
        DiagnosticsEndpointsCard(openEndpoint: openEndpoint)
        BackendLogsCard()
        LocalDiagnosticsCard()
    }
}
