import Foundation

/// One entry of `/api/config`'s additive `settings` metadata block: a managed
/// setting's running value plus where it came from.
///
/// Tier 3 — `AUTH_TOKEN`, executable paths, `TERMINAL_SHELL`, host/port, the
/// storage directories — has no entry here *by construction* on the backend,
/// which is what keeps an ungated `/api/config` non-secret. See
/// `docs/api/API.md` and `docs/safety/TRUST_AND_SAFETY.md`.
public struct PublicManagedSetting: Codable, Hashable {
    /// The value this backend process is running with; absent when unset.
    public var value: JSONValue?
    /// `env` | `file` | `default`. An environment variable wins and *locks* the
    /// key, so a settings-file value for it is inert rather than pending.
    public var source: String
    /// `1` preference, `2` trust posture.
    public var tier: Int
    /// `string` | `boolean` | `number`: the shape of this setting's value, so a
    /// client with no compiled-in presentation for the key can still choose a
    /// control for it. Reported even when `value` is absent, which is exactly the
    /// case a client could infer no shape from.
    ///
    /// Optional because a backend that predates it decodes as `nil` — such a
    /// backend also registers no runner this app was not built with, so there is
    /// nothing generic to draw.
    public var valueKind: String?
    /// The values this setting's declaration accepts, when it bounds them.
    /// Absent for an open value (a model id, a timeout), where the backend's
    /// schema stays the authority.
    ///
    /// A client must not offer free text for a key that has these: writing
    /// something outside them would look like a valid edit and come back a `400`.
    public var options: [JSONValue]?
    /// Whether `PATCH /api/config` would accept this key right now — it folds in
    /// both the environment lock and the tier-2 remote-admin gate. The macOS app
    /// writes the file directly, so it reads `source` instead.
    public var editable: Bool
    public var requiresRestart: Bool
    /// The value a backend restart would produce, present only when the file on
    /// disk no longer agrees with the running snapshot.
    ///
    /// `.some(.null)` is meaningful and distinct from `.none`: it means a restart
    /// would leave the key *unset*, where `.none` means nothing is pending at all.
    public var pendingValue: JSONValue?

    // Spelled out because the custom coding below suppresses synthesis.
    private enum CodingKeys: String, CodingKey {
        case value, source, tier, valueKind, options, editable, requiresRestart, pendingValue
    }

    public init(
        value: JSONValue? = nil,
        source: String,
        tier: Int,
        valueKind: String? = nil,
        options: [JSONValue]? = nil,
        editable: Bool,
        requiresRestart: Bool = true,
        pendingValue: JSONValue? = nil
    ) {
        self.value = value
        self.source = source
        self.tier = tier
        self.valueKind = valueKind
        self.options = options
        self.editable = editable
        self.requiresRestart = requiresRestart
        self.pendingValue = pendingValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        value = try container.decodeIfPresent(JSONValue.self, forKey: .value)
        source = try container.decode(String.self, forKey: .source)
        tier = try container.decode(Int.self, forKey: .tier)
        valueKind = try container.decodeIfPresent(String.self, forKey: .valueKind)
        options = try container.decodeIfPresent([JSONValue].self, forKey: .options)
        editable = try container.decode(Bool.self, forKey: .editable)
        requiresRestart = try container.decodeIfPresent(Bool.self, forKey: .requiresRestart) ?? true
        // Decoded by presence, not with `decodeIfPresent`: that collapses an
        // explicit JSON null into `nil`, erasing the difference between "nothing
        // is pending" and "a restart would unset this key".
        pendingValue = container.contains(.pendingValue)
            ? try container.decode(JSONValue.self, forKey: .pendingValue)
            : nil
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(value, forKey: .value)
        try container.encode(source, forKey: .source)
        try container.encode(tier, forKey: .tier)
        try container.encodeIfPresent(valueKind, forKey: .valueKind)
        try container.encodeIfPresent(options, forKey: .options)
        try container.encode(editable, forKey: .editable)
        try container.encode(requiresRestart, forKey: .requiresRestart)
        if let pendingValue {
            try container.encode(pendingValue, forKey: .pendingValue)
        }
    }
}
