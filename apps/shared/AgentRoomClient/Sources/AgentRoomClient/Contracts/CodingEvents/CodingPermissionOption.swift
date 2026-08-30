import Foundation

/// One answer a runner offered for a permission request.
///
/// A client may answer with one of these `optionId`s and nothing else — the
/// backend refuses an id the agent did not supply, so this list is the whole
/// vocabulary of an answer. `kind` is the agent's own classification
/// (`allow_once`, `reject_once`, …) and is deliberately an open string: an
/// unfamiliar one is rendered plainly rather than dropped, since dropping it
/// would hide the only answer the agent will accept.
public struct CodingPermissionOption: Codable, Hashable, Identifiable, Sendable {
    public var optionId: String
    public var name: String?
    public var kind: String?

    public var id: String { optionId }

    /// What to show on the button: the agent's own wording when it gave one.
    public var label: String { name ?? optionId }

    /// True for an option the agent classified as permitting the action. Used
    /// for emphasis only — the answer sent is always the option's own id.
    public var isAllow: Bool { kind?.hasPrefix("allow") ?? false }

    /// True only for an explicit rejection classification. An absent or newer
    /// kind is neither allow nor reject and must render neutrally.
    public var isReject: Bool { kind?.hasPrefix("reject") ?? false }

    public init(optionId: String, name: String? = nil, kind: String? = nil) {
        self.optionId = optionId
        self.name = name
        self.kind = kind
    }
}
