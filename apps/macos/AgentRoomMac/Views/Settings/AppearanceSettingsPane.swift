import SwiftUI

struct AppearanceSettingsPane: View {
    @Environment(AppAppearanceStore.self) private var appearance

    var body: some View {
        @Bindable var appearance = appearance
        Form {
            Section("Appearance") {
                Picker("Appearance", selection: $appearance.selection) {
                    ForEach(AppAppearance.allCases) { option in
                        Text(option.title).tag(option)
                    }
                }
                .pickerStyle(.radioGroup)
                SettingsCaption(text: "System follows this Mac's appearance. Light and Dark apply to AgentRoom windows and the menu bar panel.")
            }
        }
        .formStyle(.grouped)
    }
}
