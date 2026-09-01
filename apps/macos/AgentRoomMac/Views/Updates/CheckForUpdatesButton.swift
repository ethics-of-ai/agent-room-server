import SwiftUI

struct CheckForUpdatesButton: View {
    let updateController: AppUpdateController

    var body: some View {
        Button("Check for Updates…", action: updateController.checkForUpdates)
            .disabled(!updateController.canCheckForUpdates)
    }
}
