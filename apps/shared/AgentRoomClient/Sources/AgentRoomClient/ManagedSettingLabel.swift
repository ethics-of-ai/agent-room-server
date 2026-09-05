import Foundation

/// How a managed setting is named when no client was built with a name for it.
///
/// Both apps need this and neither owns it. `docs/engineering/RUNNERS.md` makes a registered
/// runner's settings renderable everywhere, which means the headset (drawing from
/// `/api/config`'s metadata) and the Mac (reading the settings file's preserved
/// sections) both have to turn `permissionPolicy` into words — and had better
/// turn it into the *same* words, or one operator's two surfaces disagree about
/// what a setting is called.
///
/// It is purely typographic and lossy only in case, so it can never turn one
/// setting's name into another's — the same property `RunnerDescriptor`'s
/// humanized display name has, and for the same reason.
public enum ManagedSettingLabel {
    /// `permissionPolicy` → `["permission", "policy"]`, `auto_allow` →
    /// `["auto", "allow"]`, `workspace-write` → `["workspace", "write"]`.
    public static func words(in identifier: String) -> [String] {
        var words: [String] = []
        var current = ""
        for character in identifier {
            if character == "_" || character == "-" {
                if !current.isEmpty { words.append(current) }
                current = ""
                continue
            }
            if character.isUppercase, !current.isEmpty {
                words.append(current)
                current = ""
            }
            current.append(contentsOf: character.lowercased())
        }
        if !current.isEmpty { words.append(current) }
        return words.isEmpty ? [identifier] : words
    }

    /// `auto_allow` → `Auto allow`. For a value in a picker, or a global
    /// setting's own title.
    public static func sentenceCased(_ identifier: String) -> String {
        let joined = words(in: identifier).joined(separator: " ")
        return joined.prefix(1).uppercased() + joined.dropFirst()
    }

    /// The row title for a setting, named by the runner that owns it:
    /// `Gemini CLI permission policy`. A global setting passes `nil` and gets its
    /// field sentence-cased instead.
    ///
    /// The runner's name is always the connected backend's answer
    /// (`RunnerCatalog.displayName(for:)`), which renders a runner no catalog
    /// describes as itself rather than as another runner — putting a wrong name
    /// on a trust setting is the one outcome worse than an ugly one.
    public static func title(field: String, runnerDisplayName: String?) -> String {
        guard let runnerDisplayName else { return sentenceCased(field) }
        return ([runnerDisplayName] + words(in: field)).joined(separator: " ")
    }
}
