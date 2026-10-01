import SwiftUI

struct SettingsPaneContent: View {
    var section: SettingsSection

    var body: some View {
        switch section {
        case .setup: SetupSettingsPane()
        case .credentials: CredentialsSettingsPane()
        case .runners: RunnerSettingsPane()
        case .models: ModelCatalogSettingsPane()
        case .languages: EditorCatalogSettingsPane()
        case .appearance: AppearanceSettingsPane()
        case .advanced: AdvancedSettingsPane()
        }
    }
}
