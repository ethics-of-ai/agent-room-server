import SwiftUI

struct SettingsView: View {
    var body: some View {
        TabView {
            SetupSettingsPane()
                .tabItem { Label("Setup", systemImage: "wand.and.stars") }

            CredentialsSettingsPane()
                .tabItem { Label("Credentials", systemImage: "key.fill") }

            RunnerSettingsPane()
                .tabItem { Label("Runner", systemImage: "cpu") }

            ModelCatalogSettingsPane()
                .tabItem { Label("Models", systemImage: "list.bullet.rectangle") }

            EditorCatalogSettingsPane()
                .tabItem { Label("Languages", systemImage: "curlybraces") }

            AdvancedSettingsPane()
                .tabItem { Label("Advanced", systemImage: "slider.horizontal.3") }
        }
        .frame(width: 580, height: 560)
        .scenePadding(.horizontal)
    }
}
