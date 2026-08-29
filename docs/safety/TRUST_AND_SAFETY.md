# Trust And Safety

Current posture:

- Registered local workspaces are the only session targets.
- The API accepts runner kinds `codex`, `claude_code`, `deepseek`, and
  `cursor`; all four execute only on the backend behind the `AgentRunner`
  boundary.
- Clients send turn messages; they do not execute shell commands.
- Runner execution stays behind the backend `AgentRunner` adapter.
- Mutating routes require bearer auth when `AUTH_TOKEN` is configured.
- Secrets are read from env or macOS Keychain and are never returned by
  `/api/config`, `/api/status`, `/api/logs`, or `/api/audit`.
- Backend configuration is a **managed settings file beside the environment**,
  and the line between what may live in that file and what may not is a trust
  boundary rather than a convenience. `$AGENTROOM_HOME/config/settings.json`
  (dev fallback `<cwd>/.agentroom/config/settings.json`) holds only *managed*
  settings: the preference tier (default runner, models, effort, feature flags,
  Git timeouts) and the trust-posture tier (terminal access and its cap, the
  Claude Code permission mode / workspace-settings loading /
  provider-credential inheritance, the Codex approval policy, sandbox mode, and
  workspace network access). `GET /api/config` reports them with provenance and
  `PATCH /api/config` edits them; the macOS app writes the same file directly,
  because its panes must keep working while the backend is stopped. Posture:
  - **The never-remote tier is absent by construction.** `AUTH_TOKEN`,
    `CODEX_EXECUTABLE`, `CODEX_ARGS`, `CODEX_RUNNER_PROTOCOL`,
    `CLAUDE_CODE_EXECUTABLE`, `TERMINAL_SHELL`, `HOST`, `PORT`, `STATE_DIR`,
    `WORKSPACE_ROOT`, `AGENTROOM_HOME`, and `EDITOR_CATALOG_DIR` are not managed
    keys, so they are not in the file, not in the metadata block, and not in the
    PATCH schema — asking for one is refused exactly as a typo is. This is not a
    filter applied late: an executable path is "run this binary", which is
    remote code execution by configuration; `AUTH_TOKEN` is the credential the
    request itself rides on; and the bind/storage class would strand or relocate
    the backend mid-edit. It is also what keeps the ungated `GET /api/config`
    non-secret — the projection cannot grow a secret it has no key for. The
    natural seam is the same one: a file cannot configure a process that has not
    started.
  - **One precedence rule, and an environment value locks the key.** Env wins,
    else the file, else the code default, and a key set in the environment is
    reported as `source: "env"` with `editable: false` — the file value for it
    is inert rather than pending. This extends the model `config/env.ts` already
    had, where real process env is protected from the `$AGENTROOM_HOME/config/.env`
    overlay, and it means an operator can still pin any managed key beyond a
    client's reach by setting it in the environment.
  - **Everything applies on backend restart, and only the Mac can restart it.**
    Config is snapshotted once at startup and the gated routes are
    registered-or-absent from that snapshot, so no route is added or removed and
    no runner is reconfigured underneath a running turn. `requiresRestart` is
    therefore always `true`, and `pendingValue` reports what a restart would
    produce, derived by re-reading the file per request — compose-on-read, no
    watcher, no cached state.
  - **The trust tier is remotely editable only behind a Mac-side master switch.**
    Without it, the bearer token alone would escalate to an unsandboxed shell
    (`terminalEnabled`) or a widened agent sandbox, collapsing the distinction
    between "may drive this backend" and "may decide what this backend is
    allowed to do". `REMOTE_SETTINGS_ADMIN` is **environment-only and default
    off**, injected by the macOS app: deliberately *not* a managed key, because a
    key in the file could be granted by whoever already holds the bearer token.
    While it is off, a patch naming a tier-2 key is a `403` naming those keys,
    and the metadata reports every tier-2 entry as `editable: false` so a client
    renders the refusal instead of discovering it. The macOS panes are
    unaffected: they edit the file on the machine the switch is protecting.
  - **A file that cannot be used is dropped whole, never applied in part.** An
    unparseable or schema-invalid file lands every key on its code default with
    one bounded startup warning, and every managed default is the conservative
    direction (terminal off, no Codex workspace network access,
    `workspace-write`). A partially applied trust posture would be a worse answer
    than the safe defaults. For the same reason the read-merge-write refuses to
    merge into a file it could not parse — that would silently drop the
    operator's other keys — and reports `409` instead.
  - **Which settings exist is declared by the runner that owns them.** The
    globals are declared in `config/settingsStore.ts`; every runner-owned setting
    is a `ManagedSettingDefinition` on that runner's `RunnerDescriptor`, carrying
    its schema, tier, environment variable, and default. The file schema, the
    env-name table, the tier table, the defaults, the PATCH schema, and the
    `/api/config` metadata are all derived from those declarations. This is a
    safety property, not only a tidiness one: the tier of a setting and the schema
    that bounds it are stated **once**, beside the runner whose posture they
    describe, so a trust setting cannot be introduced in one table and forgotten
    in another. Each declaration reuses the same schema object
    `serviceConfigSchema` is built from, which is what keeps "a file that parses
    can never make the next startup throw" true by construction rather than by
    review.
  - **One file, exactly one schema, and version 2 is what this backend writes.**
    A version-2 document nests each setting under its owner — `global.<field>`
    and `runners.<runnerKind>.<field>`. A version-1 document (flat, no
    `schemaVersion` field) is still read, and is migrated **whole** by the next
    write that changes something: never key by key, and never into a document
    holding one setting at two addresses, because that is a precedence question
    nobody should have to answer. Reading settings never rewrites the file, so a
    pane that only looks at the posture cannot change it. The rules that bound
    this:
    - A version-1 document's `global`/`runners` sections were **never applied** —
      the flat key is what the backend resolved — so the migration preserves only
      the addresses this backend does not know and **drops** the ones it does.
      Carrying a known address forward would silently activate a trust value the
      running backend had been ignoring.
    - Unknown runner namespaces and unknown fields are preserved verbatim and
      never applied (forward compatibility), while a malformed **known** value
      still makes the file unusable — the trust rule that outranks it.
    - `schemaVersion: 2` alongside a legacy top-level key is rejected outright,
      since one file has exactly one schema and assigning precedence would
      silently answer a question the operator did not know they were asking.
    - A version this backend does not know is reported as
      `unsupportedSchemaVersion`: as unusable as a broken file, and a *distinct
      state*, because a newer file is repaired by updating AgentRoom and a broken
      one by resetting it — and resetting a newer file would destroy a posture the
      operator did author. The Mac's reset refuses outright on that state.
    - `writeManagedSettings` emits version 2, or version 1 for the deliberate
      **rollback** path, and throws on anything else, so a writer can never
      strand the operator on a file only a future backend can open. Documents are
      key-sorted at every level, so the backend's writer and the macOS app's
      produce the same bytes for the same settings.
  - **Running an older AgentRoom is a supported step, not a lost posture.** An
    older build cannot be taught to read the nested document — it would call the
    file malformed and drop the whole trust posture onto defaults — so the macOS
    app's Advanced pane offers "Convert settings for an older AgentRoom", which
    rewrites the file as the flat version-1 document (deliberately with **no**
    `schemaVersion` field, because an absent version *is* version 1) through the
    same validation and atomic publish. Every setting this release knows survives
    both directions; a section only a newer release understands rides along
    unaddressed, exactly as the reader-first release taught the older reader to
    preserve it. A current AgentRoom converts the file forward again on the next
    change. One value is **refused** rather than converted: `runnerKind` naming a
    runner the older build predates (a bundled `deepseek`, an operator's own
    `acp_*`). An unknown `runners.<id>` namespace is preserved-and-never-applied,
    so a third runner's settings cross a downgrade untouched — but `runnerKind`
    is a *known* key, and the malformed-known-value rule above would then drop
    the operator's whole posture onto defaults, which is precisely what this
    conversion exists to prevent. The Mac names the runner and disables the
    conversion until the operator changes it, deliberately rather than rewriting
    it for them: which agent their turns run on is not a detail to adjust in
    service of a file format.
  - **The offline runner catalog is the same non-secret projection as the route.**
    A backend that starts successfully writes `$AGENTROOM_HOME/config/runners.json`
    beside the settings file: the id, display name, and three availability states
    `GET /api/runners` serves, and nothing else — deliberately not that route's
    fourth state, since a backend that has just started has proved no runtime
    readiness and a stopped one could only be misread. It exists because the macOS
    settings panes work while the backend is stopped and `runnerKind` is a picker
    over runners only the backend knows. It carries no descriptor policy field and
    no tier-3 material — an executable path, an environment name, a Keychain slot
    is not in a descriptor at all — which is why it can sit beside `settings.json`
    without becoming a secret. It is a cache: the backend never reads it, the Mac
    prefers its own bundled floor for an absent, unreadable, empty, or
    newer-versioned file, and a failed write is logged rather than fatal.
  - **The write is one JSON file in the backend's own config directory.** Never a
    registered workspace, never an executable path, never a shell. It is
    validated before it is written (the file schema is at least as strict as the
    service-config schema per key, so an accepted patch can never make the next
    startup throw), published atomically (sibling temp opened `O_EXCL`, then
    renamed) with mode `0600`, and serialized behind a per-process mutex.
    Cross-process contention with the macOS app stays last-write-wins for v1; an
    optimistic-lock token mirroring the workspace write's `baseModifiedAt` is the
    noted hardening.
  - **The change event carries key names, never values.** A patch that changes at
    least one key publishes one `config_reloaded` carrying `changedKeys`,
    `requiresRestart: true`, and an `audit` block repeating those names — a value
    on the wire would put the operator's trust posture in front of every
    subscriber, and durable audit persists only `payload.audit`. A tier-2 change
    also writes one `request.log.warn` naming the keys, the same reflex as the
    terminal's startup warning. `GET /api/config` stays the one place values are
    reported, which is safe only because of the tier-3 exclusion above.
  - **The metadata is LAN-readable.** `GET /api/config` is not gated by the
    mutating-method preHandler, so anything in the `settings` block is readable
    by anyone who can reach the backend — including three managed values the
    older flat projection deliberately omitted (`terminalMaxSessions`,
    `artifactsEnabled`, `languageCatalogEnabled`), because a client cannot render
    or edit a setting it cannot read. What protects it is that none of it is a
    secret: it is the operator's posture, not their credentials. The same test
    admits the two fields that describe a key's *shape* — `valueKind`, and the
    `options` a declaration bounds its value to — which report the schema rather
    than the posture and are what let a client render a setting it was not built
    with (Phase 1 of
    `docs/engineering/REGISTERED_RUNNER_COMPLETENESS.md`). They are derived from
    the declaration, so a tier-3 key has no shape to report here either.
  - **Both addresses are served, and both are accepted.** Every managed setting
    appears in that block twice — at its canonical version-2 path and at its
    version-1 flat key — and `PATCH /api/config` takes either, with
    `settingsSchemaVersion` on the same response saying which is canonical. A
    headset and a backend upgrade independently, so a client that only knows flat
    keys must keep working against a backend that has moved on. It is dual
    emission with the same retirement rule as the legacy `coding_*` metadata
    blocks: it goes when the advertised floor moves. Naming one setting at both
    addresses in a single patch is a `400` rather than a resolution — assigning
    precedence would apply a value the caller did not send.
- `GET /api/runners` reports which runners the backend registers, and is the one
  projection of a runner descriptor that leaves the process. It carries a
  runner's id, its display name, the three availability states the registry
  resolves (`registered`, `configured`, `enabled`), and the runtime-readiness
  state below — nothing else. What is absent
  is the posture: the descriptor fields that decide backend behavior
  (`promptDelivery`, `turnDiffSource`, `workspaceSkills`, `restoreStrategy`) are
  no client's business, and the tier-3 material a runner needs in order to start
  — an executable path, an environment variable name, a Keychain slot — is not in
  a descriptor at all, so `configured` can say *that* the operator supplied a
  runner's bootstrap without saying what it is. The route is additive and ungated
  for the same reason `GET /api/config` is ungated: it is the operator's posture,
  not their credentials. A client renders its runner pickers from it instead of a
  compiled-in list, so a runner the backend registers becomes selectable without
  shipping the apps again; a runner id no descriptor covers is rendered as itself
  and never coerced to a known runner, which would put a wrong name — and every
  trust posture that name implies — on a live thread. If this route is absent or
  its read fails, the Mac's stopped-backend settings path may use its full bundled
  identity floor, but a remote client uses only the runners that predate the
  route. That compatibility floor deliberately excludes newer runners until the
  backend supplies their availability; silence cannot be treated as admission.
- Runner readiness has **two authorities and stays two**, because one collapsed
  answer is how a runner comes to read "ready" in a client that cannot start it.
  - **Backend runtime readiness** — could the backend spawn this runner's child,
    complete the handshake, and read its model list? Only the adapter can answer
    it, and only in a running process. The probe is the capability discovery the
    backend already performs (`GET /api/coding-agent/capabilities`), so nothing
    spawns a second child to learn what the first established, nothing is probed
    at startup, and `GET /api/runners` stays a pollable read that initiates
    nothing. It reports the observation as `ready`, **omitted** for a runner
    nothing has asked about — "not probed" is not "not ready", and a default
    would be the same lie inverted. The state is in-memory per backend process:
    a restart has spawned nothing and says so. A failed probe reports `ready:
    false` and no text — the child's own diagnostic stays on the bounded `error`
    of the capabilities response, which is the string `util/redactSecrets`
    already covers.
  - **Mac bootstrap readiness** — is the local prerequisite satisfied? It
    inspects the operator's own machine (an installed executable, the
    presence-only `claude login` Keychain lookup, the presence-only stat of
    Cursor's SDK sign-in file) and **must work while the backend is stopped**, which is exactly when an operator is fixing why it
    would not start, so it is answered on the Mac and never served from here.
    The tier-3 material it reads — an executable path, an environment variable
    name, a Keychain account — is not in a public descriptor at all, so it can
    neither arrive from `/api/runners` nor be inferred from it. What the Mac
    reads is a **bundled** `RunnerBootstrapDescriptor` per runner: its tier-3
    slots (each naming the environment variable its value is injected as) and its
    probes (`executablePath`; `filePath`; `keychainPresence`, which stays the
    presence-only lookup described below; and `filePresence`, its file analog,
    which stats a path and never opens, reads, returns, or logs it, because
    for Cursor the file `~/.cursor/sdk/auth.json` *is* the credential). Bundled
    is the safety property — a descriptor that
    could be served would let a remote answer name a binary to run — and the
    launch environment is built by walking those descriptors, so a stored value
    for a runner or slot this build does not describe is preserved in Keychain
    and reaches no child process. Only the *default* runner's unmet required
    probes block setup, and a runner with no bundled descriptor contributes no
    check at all rather than another runner's.
- **External ACP adapters are a new trust surface, and are off by default.**
  Phase 7 of `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md` admits an
  operator-configured agent speaking Agent Client Protocol v1
  (`apps/backend/src/runner/acp`), so a second ACP-speaking agent is tier-3
  configuration rather than another adapter. Executing an operator-supplied
  binary that receives workspace paths and drives turns is **not** covered by the
  Codex or Claude Code entries above: those are two known programs with
  documented postures, and this is an arbitrary one. Posture:
  - **Off by default, and absent when off.** `ACP_ADAPTERS_ENABLED` (default
    `false`) gates the channel in the spirit of `TERMINAL_ENABLED`: with it
    unset, no definition is parsed, no runner is registered, and nothing can be
    spawned. Definitions live in `ACP_ADAPTERS`, a JSON list validated with zod;
    a malformed list is dropped **whole** with one bounded warning rather than
    applied in part, the same rule the managed settings file follows.
  - **Tier 3, environment-only, and never served.** The executable path, its
    fixed arguments, and the environment names an adapter may receive are
    environment configuration and nothing else. An executable path is "run this
    binary" — remote code execution by configuration — so it is not a managed
    setting, is absent from `GET /api/config` and the PATCH schema by
    construction, and can arrive from neither `/api/runners` nor
    `config/runners.json`. What those two report about a configured adapter is
    exactly what they report about a built-in runner: an id, a display name, the
    availability states, and the observed `ready` — never what the bootstrap is.
  - **Admission is a decision about a specific program.** The path must be
    absolute (a relative one would resolve against a *registered workspace*, so
    the repository being worked on would choose the binary), must not be a
    symlink (whose target can be repointed after the operator reviewed it), and
    must be a regular file with an executable bit. It is canonicalized with
    `realpath` and the resolved path is what is spawned. argv is assembled by the
    backend from the definition's fixed arguments: no shell, no caller fragment.
  - **The child environment is an allowlist, not an inheritance.** This is
    deliberately stricter than the built-in runners, which inherit the operator's
    environment minus `AUTH_TOKEN` (and, for Claude Code, the provider
    credentials it scrubs) because they need it to find their own credentials.
    An arbitrary allowlisted binary has no such claim, so it receives only
    `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `USER`, `LOGNAME` plus the
    credential names the operator explicitly granted it. `AUTH_TOKEN` is refused
    as a grant and never present, the same rule every other spawned child
    follows.
  - **The protocol is bounded at every step.** `AcpStdioClient` caps frame size
    (1 MB, including an unterminated line still accumulating), nesting depth
    (64, because the value reaches the canonical mapper, the bounded `native`
    blob, and durable audit), total stdout volume per child, and the retained
    stderr tail. Handshake, turn, cancel, and shutdown each carry a timeout, and
    a breach is not negotiated: the child is killed (`SIGTERM`, then `SIGKILL`)
    and every pending request rejects with a bounded reason. Every consumed
    message is zod-validated on receipt — shape validation is **not** trust, the
    allowlist is; validation is what keeps a malformed frame from reaching the
    mapper as an unchecked shape.
  - **Only restorable agents are admitted.** AgentRoom reaps idle children and
    resumes them, so an agent advertising neither `session/resume` nor
    `loadSession` is refused at `initialize` rather than allowed to silently
    begin a fresh conversation under an existing AgentRoom session id. Resume is
    preferred; a `session/load` replay is consumed with updates **suppressed**,
    because AgentRoom already holds that transcript and emitting the replay would
    duplicate every past message.
  - **Filesystem and terminal capabilities are declined.** AgentRoom advertises
    `fs.readTextFile: false`, `fs.writeTextFile: false`, and `terminal: false` at
    `initialize`. ACP's fs methods take absolute paths, carry no
    optimistic-locking or conflict detection, and mandate create-on-write — all
    three incompatible with the bounded, `baseModifiedAt`-locked,
    parent-must-exist workspace PUT that remains the only client-initiated
    workspace write. A conforming agent therefore never calls them (verified
    against the reference agent in the Phase 0b spike); one that calls anyway is
    refused per request and the breach is logged.
  - **Permission requests are refused by default.** `session/request_permission`
    selects a rejection option the agent itself offered, or cancels when it
    offered none. It never invents `allow_always` and never selects an allow
    option. The other two postures are values of that same **tier-2** per-adapter
    managed setting (`<prefix>PermissionPolicy`, env
    `ACP_<ID>_PERMISSION_POLICY`), so a paired client can only set either behind
    the Mac's `REMOTE_SETTINGS_ADMIN` switch: `ask` holds the request open for a
    person to answer (the **Interactive permission approval** section below), and
    `auto_allow` is the unattended posture. All three answer with an option the
    agent supplied *for that request* and can express nothing else.
  - **Adapter-authored text is redacted.** The bounded stderr tail and every
    error the agent's own protocol returns pass through
    `util/redactSecrets` before reaching a response, an event, or durable audit —
    the same rule as the Codex stderr tail, and for the same reason: those
    strings surface on reads the mutating-method preHandler does not gate.
  - **Ids are namespaced, and settings prefixes are checked rather than
    assumed.** A configured adapter's id must match `acp_[a-z...]`, so an
    operator cannot shadow a built-in runner or reach its managed-settings
    prefix. The namespace alone is *not* enough, though, and treating it as
    sufficient would be the mistake: two configured adapters can still derive the
    same or a prefixing settings key from different ids (`acp_foo` and
    `acp_foo_` both reach `acpFoo…`), which would resolve one adapter's trust
    setting into the other's namespace — a posture landing on the wrong runner.
    So prefixes are compared explicitly rather than inferred from the id: the
    definition reader checks each configured adapter against the others, and
    registration checks every candidate against the built-ins as well, which is
    the check that has to hold because it is the one a test or a future caller
    also reaches. A collision is refused **whole**: the reader drops the entire
    definition list, and registration validates every candidate before committing
    any, so a rejected set can never leave a partly-populated registry behind. The built-in admission list is
    what this build *ships* (`codex`, `claude_code`, `deepseek`) and an adapter
    never joins it: the rollout gate is about a *bundled* id reaching an older
    Mac's settings file, which an id that Mac's own operator configured is not. An unknown runner namespace in the
    settings document is already preserved-but-never-applied, which is what makes
    this safe.
  - **The agent's own sandbox posture is never projected into a turn setting.**
    A v1 `session/new` response carries `configOptions`, a list of session
    configuration selectors each tagged with a reserved category. `model` and
    `thought_level` map into `CodingAgentCapabilities` so an ACP runner's model
    picker works like any other runner's. `model_config` deliberately does not:
    ACP defines categories as UX hints, and that one may describe context size,
    speed/quality, or several independent controls, so presenting its first value
    as a service-tier "Speed" picker would misrepresent a compliant agent. The
    fourth category, **`mode`, is deliberately dropped**, and not for want of a
    place to put it: it is the agent's own
    approval/sandbox preset, whose values on the reference agent run from
    `read-only` to `agent-full-access` ("edit files outside this workspace and run
    commands with network access"). Turn settings are chosen per turn by anyone
    holding the bearer token, whereas every other runner trust posture — the Codex
    sandbox mode and network pin, the Claude Code permission mode, this adapter's
    own `permissionPolicy` — is a tier-2 managed setting a paired client can only
    change behind `REMOTE_SETTINGS_ADMIN`. Carrying `mode` across would put a
    sandbox-widening control on the composer with none of that gating, which is
    the same escalation the tier-2 rule exists to prevent. AgentRoom therefore
    neither reports it nor sets it; an operator who wants a different mode
    configures the agent itself. A selection is applied with
    `session/set_config_option` before the prompt (ACP has no per-turn model
    parameter, so it is session-scoped), only for a value the agent itself listed
    for that selector, and only where it differs from the live one. The required
    complete-state response must confirm the selected value, and a complete
    agent-initiated config update replaces the live record even while idle. See
    `docs/engineering/REGISTERED_RUNNER_COMPLETENESS.md`.
  - **Image attachments are negotiated per adapter, and bounded when they are
    accepted.** An agent receives image content blocks only if it advertised the
    exact ACP boolean `promptCapabilities.image: true` at `initialize`; a truthy
    malformed value and an explicit or absent `false` all fail closed. The answer
    is stored on the child that supplied it because concurrently retained
    children can negotiate differently. Before any handshake, or when completed
    handshakes disagree, synchronous validation treats support as *unknown*
    rather than letting one child authorize or refuse delivery to another; the
    selected child's own handshake then decides, with the same explicit refusal
    instead of a silently dropped attachment. When every recorded answer is
    `false`, validation can refuse before a turn exists. Because ACP has no
    local-file image source, an accepted attachment is inlined as base64 in the
    prompt frame, so
    the **total decoded image bytes one prompt may carry is bounded** (16 MB) on
    top of the per-file cap the upload already applies — eight 10 MB attachments
    would otherwise be ~107 MB of base64 written to an arbitrary child on a
    single line. It is the one outbound bound on that transport, and it exists
    for the same reason the inbound ones do.
- **Interactive permission approval lets a client authorize one action inside a
  running turn, and it is a trust surface in its own right.** Phase 2 of
  `docs/engineering/REGISTERED_RUNNER_COMPLETENESS.md`. Until it landed, a runner
  that asked permission mid-turn had two answers available: refuse everything, or
  the unattended `auto_allow` above. This is the third — ask the person driving
  the session — and everything about it is shaped by the fact that the answer
  authorizes an agent to act on the operator's Mac. Posture:
  - **Nobody is asked unless the posture says so.** The `ask` value of the
    per-adapter `permissionPolicy` is what opens the channel, and it is **tier
    2** like the other two, so a paired client can only select it behind
    `REMOTE_SETTINGS_ADMIN`. Asking is deliberately *not* implied by a client
    being connected: a posture that changed with who happened to be listening
    would be no posture at all, and every turn under the default `reject` would
    otherwise stall for the timeout before refusing. `auto_allow` still never
    asks, connected client or not.
  - **The route selects an option; it is not a "run this" endpoint by another
    name.** `POST /api/agent-sessions/:sessionId/permissions/:requestId` takes one
    outstanding request id and one `optionId`, and the runner checks that id
    against the options the **agent itself** offered for that request. An option
    the agent did not supply is a `400`; a request that is not outstanding is a
    `404`. It cannot invent `allow_always`, cannot name a tool, a path, or a
    command, and cannot reach a request in another session. It is a mutating
    POST, so the global preHandler requires the bearer token when `AUTH_TOKEN` is
    configured — authorizing an agent's action is not something an
    unauthenticated caller on the LAN can do.
  - **The wait is bounded and falls back conservatively.** A request holds for
    `permissionTimeoutMs` (5 minutes) and then gets exactly what the configured
    policy would have answered — for `ask`, the conservative refusal. A turn that
    blocks indefinitely on an absent operator is a worse failure than a refusal.
    The resolved event carries `decidedBy` (`human`, `policy`, or `timeout`),
    because "allowed" reads very differently depending on who allowed it.
  - **Outstanding requests are per session, bounded, and in memory.** At most 8
    per session — past that a request is answered by the policy rather than
    queued, which is what keeps a looping or hostile agent from growing the map —
    and an empty, duplicate, overlong, or over-cap answer vocabulary is never
    advertised as a client-answerable request. Registration happens before the
    live event carries `requestId` and `options`, so their presence means the
    route is already open. Admitted vocabularies contain at most 16 unique,
    exact option ids; opaque ids are never trimmed or truncated between the
    event, route, and store. Requests are released when the session is deleted,
    when its child dies or is torn down, and when the turn settles, so no wait
    outlives what it belongs to. Nothing about a pending request is persisted.
  - **Audit records the decision, not the payload.** A resolved request publishes
    one sanitized `agent_permission_resolved` carrying the request id, the
    selected option, the authority, and the status — and that is what durable
    audit keeps. The tool call the agent was about to run is deliberately not in
    it: it can carry anything, and a durable log is the wrong place for it. What
    the operator needs in order to *decide* rides the live
    `coding_permission_requested` event instead (the agent's own tool-call block,
    bounded by the canonical mapper like every other content it carries) — the
    same class of model-authored text the `coding_tool_activity_*` stream already
    carries, and subject to the same caveat: the recent-event buffer is readable
    through `/api/status` and `/api/logs`, which the mutating-method preHandler
    does not gate.
  - **The posture stays per-runner.** This adds an answer channel; it does not
    reconcile the Codex approval policy, the Claude Code permission mode, and an
    ACP adapter's `permissionPolicy` into one enum. The built-in runners
    answer from their own postures and expose no outstanding request (Cursor's
    SDK offers no approval callback at all), so the
    route's `404` is the honest answer for them — it reads the absence of a
    runner's approval channel, never which runner it is.
- **Clarifying questions let an agent pause a turn to ask the person driving
  the session for direction, and answering one authorizes nothing.** A runner
  that is unsure which way to go raises one *batch* of one or more *sets* —
  each a prompt, the options it offers, how many may be chosen, and whether
  free text is accepted beside or instead of a choice — and waits; the person
  answers through one route and the turn continues with the answers. It is the
  sibling of interactive permission approval on the same shared waiting store
  (`runner/shared/PendingRequests.ts`, `PendingQuestionRequests.ts`), and it
  differs from it in the one way that matters: a permission answer lets an
  agent *act* on the operator's Mac, whereas a question answer is the person's
  own choices and words going back to an agent that asked for them — the same
  class of input as the turn message. Posture:
  - **One route, minted ids, no invented answers.**
    `POST /api/agent-sessions/:sessionId/questions/:requestId` selects options
    the agent itself offered per set, and carries free text only where the set
    invited it. At least one set must be answered; a set marked `required`
    needs nonblank discussion even when it also offers options. Request, set,
    and option ids are AgentRoom's (`question-<uuid>`,
    `set-<n>`, `opt-<n>`); each adapter keeps the map back to the agent's own
    question text and labels, so nothing a client sends is a string the agent
    interprets as an id. A set or option the agent did not offer is `400`; a
    batch that is not outstanding is `404` — which is also the honest answer
    for a runner with no way to ask, because the route calls an optional
    `AgentRunner.answerQuestionRequest` hook and never reads runner identity.
    Mutating, so the global preHandler requires the bearer token. The read
    beside it, `GET /api/agent-sessions/:sessionId/questions`, returns
    model-authored question text and is gated like `/messages`.
  - **The wait is bounded, and a timeout is reported as a timeout.** A batch
    holds for ten minutes (longer than a permission request's five: a question
    asks for a decision, and a headset put down to think about one should still
    find the turn waiting), then the runner applies its own away fallback — the
    agent is told nobody answered and to proceed on its best judgment — and the
    resolved event says `decidedBy: "timeout"`. The channel never picks a
    default option on the person's behalf; a cancelled turn or a lost child
    resolves the batch `cancelled`, with no authority at all.
  - **Outstanding batches are per session, bounded, and in memory.** At most 8
    per session (a blocking agent asks one at a time; the cap is for a looping
    or non-blocking one), at most 8 sets of at most 8 options, text clamped at
    every boundary, and a batch outside those bounds is refused to the agent
    rather than truncated into a vocabulary the person never saw. Released when
    the turn settles, the child dies, or the session is deleted; nothing about a
    pending batch is persisted. A turn blocked on a question is busy, so the
    session host never idle-reaps its child underneath it.
  - **Audit records the decision; the thread records the words.**
    `agent_question_resolved` carries the request id, status, authority, and
    each answered set's option ids — never the free text. The free text is the
    person's own message and goes where their messages go: the backend appends
    the rendered answer to the session history as a `role: "user"` message
    (`context.questionRequestId`), which the bearer-gated `/messages` read
    serves. A set the agent marked `sensitive` renders its discussion field
    securely. Codex's `isSecret` mapping is free-text-only; a prompt-contract
    runner may still offer non-secret option labels beside sensitive discussion.
    AgentRoom sends that discussion only to the agent and omits it from the
    resolved event, message, audit, and logs. As with any model input, the model
    can choose to restate it in later assistant output; `sensitive` is a storage
    and rendering rule, not a model non-disclosure guarantee.
  - **Claude Code's posture is unchanged by supplying the SDK callback.** The
    CLI's `AskUserQuestion` tool reaches the host only through the SDK
    `canUseTool` callback, and the CLI routes it there *before* consulting the
    permission mode — so under the default `bypassPermissions` the callback is
    invoked for that tool alone (verified against SDK 0.3.172 / CLI 2.1.172:
    read-only and mutating tools never reach it). Under a stricter configured
    mode a tool that needs a prompt does reach it, and the runner refuses it
    with the CLI's own headless wording — exactly what the headless CLI did
    before the callback existed. The callback is never passed to the isolated
    capability probe, and it is passed at all only while
    `clarifyingQuestionsEnabled` is on; off, the SDK adds no permission-prompt
    tool and the CLI behaves as it did before the channel.
  - **Codex's tool is switched on per thread, and the dispatcher that serves
    it refuses everything else.** The app-server's `request_user_input` tool is
    "unavailable in Default mode" unless two config keys are set, so the runner
    pins `tools.experimental_request_user_input = { enabled: true }` and
    `features.default_mode_request_user_input = true` on `thread/start` and
    `thread/resume` the same way it pins the network-access key — per thread,
    following the managed switch, never by editing the operator's global Codex
    config (verified against codex-cli 0.149). Serving the request meant giving
    `JsonRpcLineClient` a request dispatcher it never had; every other
    server→client request — the approval family under a prompting
    `approvalPolicy`, a method a newer app-server invents — is now refused
    with a JSON-RPC `-32601` and a warn log, where before it was silently
    dropped and the turn hung waiting for an answer nobody would send. A
    question the agent marks `isSecret` maps to a `sensitive` free-text set.
  - **DeepSeek's question channel is model-authored control text with a narrow
    grammar, not a server-to-client request.** The DeepSeek descriptor owns the
    standing instruction because its parser owns the matching syntax;
    `AgentTurnContextAssembler` injects it only for `prompt_contract` mode. The
    streaming parser accepts at most one line-start `<agentroom-question>` JSON
    block per Harness protocol turn, buffers at most 64 KiB, zod-validates the
    shared 8-set × 8-option vocabulary and text caps, and mints every set and
    option id itself. It removes only a complete valid block. Inline,
    malformed, incomplete, oversized, or later blocks remain assistant prose,
    so model variability cannot silently erase output. A valid block is still
    model-authored text: it rides the live canonical request and the
    bearer-gated re-seed read under the same caveat as native question text.
    Parsing it authorizes nothing and performs no action.
  - **A DeepSeek answer continues the same AgentRoom turn through a second
    Harness prompt.** The first Harness `turn/end` does not settle the public
    turn while a parsed batch is pending. The existing bearer-gated answer
    route settles the shared wait; the adapter maps offered ids back to labels
    and invited discussion, sends no AgentRoom ids, and queues that text on the
    already-live Harness session. The continuation's terminal event settles
    the AgentRoom turn. Timeout or an unavailable wait sends no choice and asks
    the model to proceed on its best judgment. Sensitive discussion is sent in
    that internal prompt but stripped from the canonical resolution before the
    shared transcript and audit paths see it. Cancellation, child loss,
    session deletion, and disposal release the wait. This adds no route,
    permission, shell, or process surface.
  - **Cursor's question channel is one custom tool AgentRoom registers, and
    the SDK's own `askQuestion` is always disallowed.** The SDK's built-in tool
    is absent from the headless catalog (fact 3 of
    `docs/engineering/CURSOR_SDK_RUNNER.md`), and every `agent/start` passes
    `disallowedTools: ["askQuestion"]` so a later SDK cannot open a question
    path AgentRoom has no answer for. While `clarifyingQuestionsEnabled` is on,
    the host registers `ask_user_question` as a `local.customTools` entry whose
    input schema is the shared 8-set × 8-option vocabulary; its `execute` sends
    one `question/ask` request to the backend over the host's own JSON-RPC and
    awaits the answer, so the SDK's tool call stays open for exactly the shared
    wait. The backend mints every id and emits the same canonical pair; the
    tool result the model sees is the person's labels and invited text, never
    an AgentRoom id; a timeout returns a result saying nobody answered and
    asking the model to continue on its best judgment. A `sensitive` set's text
    enters that tool result and is stripped from the canonical resolution,
    transcript, audit, and logs. Off, no tool is registered and no prompt
    mentions one. The vendor's note that a custom tool "never requires
    interactive approval" is correct here: answering it authorizes nothing, and
    the sandbox and auto-review posture are untouched by it.
  - **One tier-1 kill switch.** `clarifyingQuestionsEnabled` (env
    `CLARIFYING_QUESTIONS_ENABLED`, default on) is a preference, not a trust
    setting: answering a question widens nothing, and turning the channel off
    costs only the agent's ability to ask. Every runner reads it the same way —
    off means the runner is given no channel at all, never a channel that
    answers on the person's behalf. For DeepSeek, both the standing instruction
    and the parser are absent; matching text the model emits anyway remains
    ordinary assistant prose. Codex's per-thread enable flags are explicitly
    pinned false so a user-global Codex config cannot bypass the switch, and a
    defensive request handler returns an empty answer if a process asks anyway.
- The API does not expose arbitrary shell execution.
- Bounded harness actions use fixed command templates, require registered
  workspace paths, and reject resolved project paths outside that workspace.
- Workspace registration requires existing absolute directories.
- Registration stores metadata under `STATE_DIR`, not inside selected folders.
- User-selected workspaces are preserved unless the user explicitly deletes
  them outside AgentRoom.
- Workspace tree and file-preview APIs are read-only, registered-workspace-only,
  bounded, symlink-checked, and bearer-authenticated when `AUTH_TOKEN` is
  configured.
- Workspace mutation is limited to seven fixed routes:
  `PUT /api/workspaces/:id/file` → `WorkspaceExplorer.writeTextFile`,
  `DELETE /api/workspaces/:id/file` → `WorkspaceExplorer.deleteFile`,
  `POST /api/workspaces/:id/directory` → `WorkspaceExplorer.createDirectory`,
  `POST /api/workspaces/:id/entry/rename` → `WorkspaceExplorer.renameEntry`,
  `POST /api/workspaces/:id/entry/move` → `WorkspaceExplorer.moveEntry`,
  `POST /api/workspaces/:id/entry/copy` → `WorkspaceExplorer.copyEntry`,
  and `DELETE /api/workspaces/:id/directory` →
  `WorkspaceExplorer.deleteDirectory`. All are mutating, so the global
  preHandler requires bearer auth when `AUTH_TOKEN` is configured (they do not
  use the read-auth helper). All reuse the read path's bounding: the relative
  path is lexically normalized (rejecting NUL, absolute, and `..` segments)
  before any filesystem call, the workspace root is not an entry target,
  containment is asserted against the realpath of the existing parent, and any
  secret-named (`.env*`, key material) or generated-directory (`.git`,
  `.agentroom`, `node_modules`, build dirs) segment is refused in both the
  caller path and the resolved parent. Mutations also refuse every name hidden
  from tree and index reads, including `.DS_Store` and the internal
  `.agentroom-tmp` staging suffix, so a caller cannot create a successful result
  that the workspace APIs immediately conceal. An in-workspace directory
  symlink cannot tunnel a mutation into an excluded directory, and a symlink
  leaf is refused.

  The PUT body is UTF-8 text only (NUL-rejected), capped at 256 KB. Overwrites
  require an optimistic-lock `baseModifiedAt` matching the current on-disk mtime
  — a missing or stale token returns `409`, so a blind overwrite of a file
  changed since the client loaded it is rejected. If the token names a path
  removed by a concurrent rename or delete, PUT also returns `409` instead of
  recreating the old name. A PUT without that token is create-only. The write
  is atomic (sibling temp opened `O_EXCL`, then renamed over the leaf), uses
  `node:fs` only (no shell, no Git), and emits `workspace_file_written`.

  File DELETE requires `baseModifiedAt` for every request, accepts regular files
  only, and calls `node:fs.unlink` only after the token matches. It emits
  `workspace_file_deleted`.

  Directory POST creates one empty directory and is the only mutation with no
  `baseModifiedAt` — it replaces nothing, so there is no prior version a caller
  could be asked to prove it had seen. What stands in for the token is
  exclusivity: `mkdir` runs **without** `recursive`, so an occupied name is
  `EEXIST` rather than a silent success on a folder someone else made, and the
  route answers the same `409` rename, move, and copy give. It is also what
  keeps the route from becoming "materialize this whole path": the parent must
  already exist, exactly as it must for the PUT, so one request creates one
  directory. The path passes the same lexical bound, secret/generated refusal on
  both the caller's text and the resolved parent, and realpath containment as
  every other write, and the leaf goes through rename's own 255-byte name rule.
  The response carries the new directory's `modifiedAt`, so it is immediately a
  rename, move, paste, or delete target without a second read. It emits
  `workspace_directory_created` (`workspaceId`, `workspacePath`, `path`) and is
  deliberately the one mutation that does **not** invalidate the file index: that
  index enumerates files, and an empty directory contributes none.

  Rename also requires `baseModifiedAt` and accepts only a regular file or
  directory. `newName` is one trimmed leaf name, at most 255 UTF-8 bytes; it
  cannot contain `/`, name `.`/`..`, enter a protected path, change the parent,
  or overwrite a sibling. A same-name request is an idempotent no-op, and the
  same-inode exception allows a case-only rename on a case-insensitive Mac
  filesystem only when both spellings resolve to that same directory entry;
  a distinct hard link is an occupied sibling and returns `409`. A file
  destination is claimed without overwrite by an exclusive hard link before
  the old link is removed; a directory destination is first reserved as an
  empty directory before `node:fs.rename`. If another process wins either
  destination race, the request fails rather than replacing its entry.
  Case-only same-entry renames use `node:fs.rename` directly. A successful
  change emits `workspace_entry_renamed`
  with `oldPath`, the new `path`, `entryType`, and file size when applicable.

  Move is rename generalized to a second directory, and it is **one
  implementation**: rename calls it with the entry's own parent, so the
  no-overwrite claim above is the same code in both contracts rather than two
  that can drift. `destinationParent` is bounded exactly as every other written
  parent is (lexical bound, realpath containment, secret/generated refusal on
  the caller's text *and* the resolved path, and it must be a real directory);
  `newName` is optional and an omitted one keeps the entry's own name. Two
  refusals exist only because a second directory is involved: a folder moving
  into itself or a descendant is refused on realpaths, so a symlinked
  destination cannot smuggle the source's own subtree past a lexical check, and
  a destination on another filesystem (a volume mounted inside a registered
  workspace) is reported rather than surfacing as an unhandled `EXDEV`. Move
  never takes a collision strategy: silently renaming an entry someone asked to
  *move* would apply a decision they did not make, so an occupied destination is
  the same `409` rename gives. If a symlinked parent spelling resolves back to
  the source's existing directory entry, move returns an idempotent no-op and
  emits no event. Success emits `workspace_entry_moved`, whose payload matches
  the rename event so a client re-keys the old path identically. This is still
  not a general move surface: no shell, no path pair the caller assembles, and
  no destination outside the same registered workspace.

  Copy duplicates one entry inside the same workspace and is the **one workspace
  write whose bytes never transit the API**, which changes what bounds it: the
  256 KB cap is a request-body bound and says nothing here, so copy is bounded
  by the recursive-delete caps instead — 20,000 entries and 1 GiB — applied to a
  single file as much as to a tree, with the same refusals for symlinks,
  protected/generated names, and unsupported entry types. That is a deliberate
  widening over what a client could previously write in one request, and the
  residual it leaves is disk fill by repetition, which the PUT already has at
  256 KB a time. Everything is inventoried before a byte is written, the result
  is staged beside the destination and published under the caller's chosen name
  only once complete (so a failure leaves nothing partial for someone to mistake
  for the copy they asked for), and the copy pass re-checks every entry rather
  than trusting the inventory, since the two passes run over a live filesystem.
  Regular files are opened with `O_NOFOLLOW`; the opened device/inode, size, and
  mtime must still match the entry the walk selected, the bytes are read through
  that pinned handle under the 1 GiB cap, and the handle is statted again before
  publication. Selected directories are likewise checked before and after
  listing. A source swapped for a symlink or another inode therefore fails the
  copy instead of redirecting it, and the response counts come from the copy
  pass rather than the earlier inventory.
  `baseModifiedAt` is required even though copy touches nothing: it is not
  protecting the source from loss, it is what makes "this is a copy of the entry
  I was looking at" true, and a stale token means re-read and copy again.
  `onCollision` defaults to `fail` — the same refusal rename gives — and
  `keep_both` walks a bounded `-2`…`-5` name ladder that suffixes the stem
  rather than the extension and then refuses, so the server never renames unless
  asked and always reports the name it took. Success emits
  `workspace_entry_copied`, carrying `sourcePath` rather than `oldPath` because
  a copy vacates nothing.

  Directory DELETE requires the rendered directory's `baseModifiedAt` and
  inventories the complete subtree before removal. The preflight refuses any
  symlink, protected/generated name, socket/device/other non-file entry, more
  than 20,000 entries including the selected directory, or more than 1 GiB of
  regular-file data. A failure removes nothing. After inventory the selected
  directory's type and mtime are checked again, then `node:fs.rm` removes that
  directory recursively; the workspace root is never accepted. Success emits
  `workspace_directory_deleted` with file/directory counts and total regular-file
  bytes. A symlink introduced after preflight is unlinked rather than followed,
  but a concurrent process can add or alter a contained regular file after its
  check and before removal. The operation is therefore bounded and symlink-safe,
  not a transactional filesystem snapshot.

  Mutation events carry workspace identity, relative paths, types/counts, and
  byte counts only — never file content. Durable audit entries retain the event
  type and workspace identity, not file bytes. Every mutation intentionally
  dirties the working tree, which can later `409` a branch switch or
  session-branch restore; that consequence is surfaced through the existing
  Git-status refresh, not auto-committed or stashed. This slice does not block
  workspace mutation while a runner turn is active, so a client action can race
  a concurrent unsandboxed turn; optimistic tokens narrow that race but do not
  make mtime checks transactional with rename/unlink/removal.
- Session content reads that expose model/user text — the session list and
  detail reads through their `lastMessage`, agent session messages (`/messages`),
  and live artifacts (`/artifacts`) — also require the bearer token when
  `AUTH_TOKEN` is configured, since the global preHandler only gates mutating
  methods. The shared read-auth check lives in `routes/readAuthorization.ts`.
- **Agent session records are persisted under `STATE_DIR`**, one JSON document
  per session at `sessions/<sessionId>.json` holding the session record, its
  turns, and its message history: user text, assistant text, and the backend's
  own question-answer messages. A backend restart, a crash, or a DMG update
  therefore no longer empties `GET /api/agent-sessions`, and the next turn on a
  restored thread continues the native conversation the runner was already
  holding. This is the same class of data as session attachments (already under
  `STATE_DIR`) and the runners' own transcripts (already on this disk under the
  operator's home), not the audit log: it is **not** passed through
  `redactSecrets`, because a redacted transcript is a corrupted thread, and it
  is read back only through the routes that require the bearer token for
  session content: the list and detail reads, `/messages`, and `/artifacts`.
  The directory is created `0700`. Posture:
  - **Write-through, never write-at-exit.** Every mutation of a session, a
    turn, or the message list marks the record, and the store coalesces marks
    into at most one write in flight per session, so a crash, the parent-exit
    watchdog's abrupt exit, or a force quit loses at most one coalesced write.
    Persistence never depends on a graceful shutdown. There is one now all
    the same: `SIGINT` and `SIGTERM` run `app.close()` under a two-second
    ceiling (`util/shutdown.ts`) — inside the macOS supervisor's three-second
    `SIGINT` window, so its `SIGTERM` escalation stays the backstop — which is
    what runs the runner `dispose()` hooks that end resident children, the
    terminal teardown, and the store's flush. A second signal during the close
    exits at once. The parent-exit watchdog keeps its abrupt exit; write-through
    is what makes that safe.
  - **A restart is an interruption, not a decision.** A turn that was running
    when the process ended settles at the next startup through the ordinary
    failure path with the fixed reason `Backend restarted during this turn`:
    the assistant message for that turn is marked failed, the session drops to
    `failed`, and `agent_turn_failed` reaches durable audit because the audit
    store is attached before the session service is built. An outstanding
    permission or question batch ends with that turn the way a cancelled one
    does: nobody chose, and a restart is never a default choice.
  - **The runner's memory is seeded from AgentRoom's record, never rebuilt
    from the runner's transcript.** A hydrated session's recorded native id is
    handed to its runner through the optional `AgentRunner.rememberResumableId`
    hook, and the next turn takes the same acquire-miss resume branch a reaped
    or crashed child takes, with the same explicit runtime settings and
    isolation posture as a fresh start. Reading `~/.codex/sessions` or
    `~/.claude/projects` to reconstruct a thread would put per-runner file
    knowledge above the `AgentRunner` boundary and make AgentRoom's thread a
    projection of a file another program owns and prunes.
  - **A resume the runner did not honor is reported, not hidden.** A rejected
    resume already falls back to a fresh native thread with a warning in the
    log; after a restart that would be a silent memory wipe from the person's
    side, with the transcript on screen and an agent that has never seen it.
    So when a restored thread's runner reports a session start whose native id
    differs from the seed, the backend appends one `system` message to the
    thread saying the agent has started a new conversation and has not seen
    the messages above. The native ids stay in the log; the thread carries
    neither. The check compares two values of the same field and asks no
    runner anything new. Which runners reach it depends on what each does
    with a stale id: Codex and ACP fall back to a fresh thread (so they get
    the message), while Claude Code fails the turn with the SDK's own error
    (`No conversation found with session ID: …`, observed against CLI
    2.1.246 after its transcript was deleted) and starts nothing. Either way
    the person sees it, and a fresh conversation is never presented as the
    old one.
  - **A runner that declares no restore path never continues a restored
    thread.** A hydrated session whose descriptor says
    `restoreStrategy: "unsupported"` (DeepSeek) and that had a native
    conversation hydrates as readable history, and its next turn is refused
    with `409` and the adapter's own wording, so a restart never begins a fresh
    conversation under an existing thread's id — the outcome the shared host
    is built to prevent. The mark is derived from the document and the
    descriptor at every hydration and never persisted; it reads a descriptor
    field, never a runner's name. A session whose runner this process does not
    register (an ACP adapter removed from `ACP_ADAPTERS`) hydrates the same way
    and its turn gets the `400` an unconfigured runner already gets.
  - **Deleting a thread removes its document before the delete is reported**,
    after the runner's child and the attachments are released, so an
    explicitly deleted thread is never hydrated and a delete that fails midway
    leaves the file rather than losing it. The store marks the session id
    deleted before it waits for an in-flight write, so a queued or late runner
    event cannot schedule a replacement document while deletion yields. The
    runner's resume token is forgotten in the same call as before.
  - **Version skew follows the settings-file rules.** A document a newer build
    wrote is left untouched, counted, and not served (update the app, not reset
    the thread); a document this build cannot validate is left in place and
    logged. Nothing is deleted on read.
  - **No route, event, or bound is added.** `GET /api/agent-sessions` serves the
    hydrated list through the same code path as a live one. There is no cap on
    session count, thread length, or age; the delete route remains the one way
    a thread goes away.
- Workspace Git status reads are read-only, registered-workspace-only, bounded
  to changed file metadata, and bearer-authenticated when `AUTH_TOKEN` is
  configured because changed paths and line counts expose project structure.
- Workspace Git file-baseline reads (`GET /api/workspaces/:id/git/file-base`,
  serving a file's HEAD blob so editors can render working-tree change
  decorations) are read-only, registered-workspace-only, and bearer-authenticated
  when `AUTH_TOKEN` is configured because they return committed file content. The
  route runs fixed `git cat-file` invocations (no shell), shares the preview
  path's lexical bounding and secret-name refusal (a committed `.env` is as
  sensitive at HEAD as on disk), applies the same NUL/binary rejection and 256 KB
  cap (an over-cap blob returns metadata only, never partial content), and
  resolves the pathspec `HEAD:./<path>` relative to the registered workspace
  directory so a workspace registered inside a larger repository stays bounded to
  its own subtree. Files absent from HEAD and non-repository workspaces are
  ordinary data responses, not errors, and like the other reads the route emits
  no events or audit entries.
- Workspace skills listing reads (`GET /api/workspaces/:id/skills`, backing the
  clients' composer `/` slash picker) are read-only, registered-workspace-only,
  and bearer-authenticated when `AUTH_TOKEN` is configured because skill names
  and descriptions expose project structure. The route scans only the fixed
  committed skill directories each runner kind natively loads (`.claude/skills`
  for Claude Code; `.codex/skills` and `.agents/skills` for Codex), reuses the
  tree read's symlink containment (an escaping link is skipped, not followed),
  parses only each `SKILL.md`'s frontmatter `name` and `description` — never
  body content, which remains subject to the normal preview rules — and loads
  or executes nothing: it is discovery metadata for autocompletion, not a
  loading mechanism. For `claude_code` the response mirrors the
  workspace-settings gate above: when sessions would not load workspace skills
  (`CLAUDE_CODE_LOAD_WORKSPACE_SKILLS=false` or a stricter permission mode) it
  reports `available: false` with an empty list, so clients cannot offer
  invocations an isolated session would ignore. Like the other reads, it emits
  no events and no audit entries.
- Workspace file-index and content-search reads (`GET /api/workspaces/:id/files`,
  the ranked file list backing quick-open and the composer `@` mention picker, and
  `GET /api/workspaces/:id/search`, the literal-substring "search in all files"
  read) are read-only, registered-workspace-only, bounded, and
  bearer-authenticated when `AUTH_TOKEN` is configured: the index exposes project
  structure and the search returns matched file content, which puts both in the
  same sensitivity class as the file-preview read. Like the other reads they emit
  no events and no audit entries. Posture:
  - **One filtered enumeration, shared by both.** Both routes rank or scan the
    same per-workspace path index (cached ~15s, dropped when the bounded write
    creates a path or a branch switch changes the checkout, and released when
    the workspace is unregistered), so there is exactly
    one place where a path can enter either surface. A Git workspace enumerates
    through a fixed `git ls-files -z --cached --others --exclude-standard` argv
    with the registered workspace as cwd — no shell, no client-supplied
    arguments — which bounds the listing to that directory's own subtree even
    inside a larger repository and gets `.gitignore` respect for free; anything
    else falls back to a bounded filesystem walk that never descends through a
    symlinked directory.
  - **The path filter applies to Git's output too.** Every candidate passes the
    shared lexical bound (`boundedRelativeSegments`: NUL bytes, absolute paths,
    and `..` segments rejected) and then a per-segment refusal of secret names
    (`.env*`, key material) and generated directories (`.git`, `.agentroom`,
    `node_modules`, build dirs) — including paths that came back from Git, via
    `indexableRelativePath` — so those files can be neither listed nor searched
    regardless of whether they are tracked. Realpath containment is re-checked
    **at point of use**, not only when the index was built, so a leaf or
    intermediate segment that became a symlink out of the workspace after
    enumeration is skipped rather than followed, and the search reads apply the
    preview path's NUL/binary rejection (a binary file is read, counted as
    scanned, and skipped, never returned).
  - **No caller-supplied pattern is ever compiled.** Regex is deliberately
    excluded from v1: a caller-supplied pattern evaluated in-process is a ReDoS
    vector against the single-threaded backend, so `query` is a literal substring
    with only `matchCase`/`wholeWord` modifiers. The optional `include` filter is
    a simple glob applied by a linear two-pointer matcher for the same reason —
    it is never translated into a regular expression.
  - **Every bound reports partial results instead of running long.** 20,000
    indexed paths, at most 200 index results per request (default 50), at most
    2,000 files scanned, 20 matches per file, 500 total matches, 256 KB read per
    file (the same ceiling as the read/write path), a 3,000 ms wall-clock budget,
    and a 200-character match preview. Each is
    surfaced through a `truncated` flag, the same convention as the 200-file
    Git-status cap, so a large or hostile repository degrades to a partial answer
    rather than an unbounded request.
  - **Shared Git stdout ceiling.** Adding `ls-files` required raising the
    `execFile` stdout ceiling in `workspace/git/execution.ts` from Node's 1 MB
    default to 16 MB: past the limit `execFile` fails the *whole* command with
    `ENOBUFS`, which `ls-files` hits on a large repository and a very dirty tree's
    `status --porcelain` could hit too. The raise is shared by every fixed Git
    invocation; each consumer still caps how much of the output it retains.
- Git branch switching is limited to a fixed registered-workspace endpoint. It
  accepts only an existing local branch name, uses `git switch` without a shell,
  and rejects branch changes when the workspace has uncommitted or untracked
  changes.
- Mutating Git operations (`POST /api/workspaces/:id/git/{stage,unstage,discard,
  commit,fetch,pull,push,branch/create}` → `WorkspaceGitService`) are the
  source-control counterpart to that branch switch, and they stay inside the same
  boundary: they are the *only* way a client changes Git state, and they are not a
  shell. Posture:
  - **Fixed argv, never a command.** Every operation is a fixed argument vector
    assembled in `LocalWorkspaceGit` and run with `node:child_process.execFile`
    (no shell). A caller contributes workspace-relative pathspecs and a commit
    message — never a flag, a refspec, a remote, or a ref. There is no
    caller-supplied `--` passthrough and no operation that takes arbitrary Git
    arguments, so this cannot become the arbitrary-shell surface the terminal is
    the single documented exception for.
  - **No history rewriting, and no forced push.** The exposed set deliberately
    excludes amend, reset, rebase, cherry-pick, tag, remote add/set-url, and
    `push --force`/`--force-with-lease`. Pull is **fast-forward only**
    (`git pull --ff-only`): a diverged branch fails with git's own message rather
    than producing a merge commit or a conflicted worktree that a client with no
    conflict-resolution surface could not finish. A rejected non-fast-forward push
    is likewise surfaced, never forced past.
  - **The same path filter as every other workspace surface.** Every
    caller-supplied path passes `indexableRelativePath` — the shared lexical bound
    (NUL, absolute, and `..` rejected) plus the tree read's per-segment refusal of
    secret names (`.env*`, key material) and generated directories (`.git`,
    `.agentroom`, `node_modules`, build dirs). An explicitly named refused path is
    a `415` rather than a silent drop; a "stage everything" enumeration skips them
    and reports them in `skippedPaths`. This is what keeps a secret-named file out
    of an index this API would then commit and push, so it is a stronger rule here
    than for a read: staging is the step before exfiltration.
    Explicit stage and unstage requests must also resolve to exact changed-file
    entries. Directory pathspecs are rejected, preventing a safe parent such as
    `src` from recursively staging a refused child such as `src/.env`.
  - **`git add -A` is never run.** "Stage all" enumerates changed paths from an
    uncapped `status --porcelain` read, filters them, and passes the survivors as
    `:(literal)` pathspecs in bounded batches — so the filter above cannot be
    bypassed by staging wholesale, and a very dirty tree cannot silently miss
    files the 200-file status projection would have dropped. The `:(literal)`
    prefix means a path beginning with `:` is read as a path, never as Git
    pathspec magic.
  - **Commit validates the complete index.** `git commit` records the repository's
    whole index, even when AgentRoom registered only a subdirectory and even when
    another process staged the entry. Immediately before committing, the backend
    reads that full staged set and rejects any path outside the registered
    workspace or refused by the secret/generated filter. Workspace status and
    path operations remain scoped and relative to the registered subdirectory;
    the broader read exists only for this pre-commit guard.
  - **Discard is destructive and explicit.** It reverts each named path to its
    HEAD content and deletes a path HEAD does not have (untracked, or added to the
    index only). The discarded work is not stashed anywhere and cannot be
    recovered. It therefore has **no "discard all"**: a caller names every path,
    and the visionOS client confirms before sending.
  - **Remote operations are non-interactive and credential-safe.** Fetch, pull,
    and push run with `GIT_TERMINAL_PROMPT=0` and SSH batch mode
    (`GIT_SSH_COMMAND=ssh -o BatchMode=yes`, both respecting an operator-set
    value), so a repository that would need an interactive prompt fails with git's
    error instead of hanging a request invisibly. Credential helpers (the macOS
    keychain helper) are deliberately left intact — they are what makes an HTTPS
    push work without a prompt — and the backend neither reads, stores, nor logs
    any credential. These three operations carry their own longer timeout
    (`GIT_NETWORK_TIMEOUT_MS`, default 120s) so a slow fetch is not mistaken for a
    hung local command, and that timeout also bounds a helper that stalls.
  - **Git's own error text is redacted before it leaves the backend.** A remote
    failure can echo the remote URL, and an HTTPS remote can carry credentials in
    its userinfo (`https://user:token@host/repo`), so `gitErrorMessage` strips URL
    userinfo and then applies the shared `util/redactSecrets` helper before the
    text reaches an HTTP response, an event, or durable audit. It also falls back
    to stdout, because some git failures (a commit with nothing staged) explain
    themselves there.
  - **Commit runs the workspace's hooks.** `git commit` is not passed
    `--no-verify`, so the registered workspace's `pre-commit`/`commit-msg` hooks
    execute — the same committed-configuration trust the workspace already carries
    for the bundled runners (Codex's `.codex/config.toml` layer, Claude Code's
    `project` settings source, Cursor's `.cursor/hooks.json`). A hook that
    rejects the commit surfaces its message; a hook
    that hangs is bounded by the local command timeout.
  - **Bearer-authed, sanitized, and audited.** All eight are mutating POSTs, so the
    global preHandler requires the bearer token when `AUTH_TOKEN` is configured;
    none opts into the read-auth helper. Each publishes one
    `workspace_git_operation` event carrying identifiers, the operation, the
    resulting branch/commit, and counts — **never file content, never a path list,
    and never a remote URL** — plus the durable audit entry that event produces.
  - **Same concurrency caveat as the bounded file write.** These operations do not
    block while a runner turn is active, so a client commit can still interleave
    with an unsandboxed Claude Code turn writing files. Git's own index locking
    prevents a corrupt repository, but not a commit that captures a half-finished
    turn; an active-turn guard is the same recommended next hardening noted for
    the file write.
- Codex workspace network access is disabled by default for AgentRoom JSON-RPC
  sessions. Operators may explicitly enable it for trusted registered
  workspaces — through the managed settings file or an environment variable,
  both of them trust-tier decisions per the block above — when turns need
  networked Git operations such as fetch, pull, or push. The backend pins
  `sandbox_workspace_write.network_access` explicitly in the Codex
  `thread/start` and `thread/resume` configs in **both** states (not only when
  enabling), because a
  registered workspace's committed `.codex/config.toml` merges into the
  thread's effective config as a Codex project layer and an omitted key would
  let the workspace silently re-enable network access inside the
  `workspace-write` sandbox; the explicit override makes
  `CODEX_WORKSPACE_NETWORK_ACCESS` authoritative over every config layer.
  Commit and push workflows also need a sandbox
  mode that can write `.git` metadata; the packaged Mac app's Runner toggle
  sets the Codex JSON-RPC app-server launch,
  `CODEX_SANDBOX_MODE=danger-full-access`, and network access together.
- Codex sessions natively load the registered workspace's committed agent
  configuration. This is Codex app-server behavior that AgentRoom neither adds
  nor can switch off (verified against codex-cli 0.142.5, which exposes no
  isolation lever for it). Starting a thread in a registered workspace loads:
  - the workspace `AGENTS.md` as thread instructions;
  - repo-scoped skills from the workspace's `.codex/skills` and
    `.agents/skills` directories;
  - the workspace's `.codex/config.toml` as a Codex **project config layer**
    merged into the thread's effective config — including `mcp_servers`
    entries, which are registered for the session and execute on the
    operator's Mac outside the turn sandbox, and any `hooks` configuration.
  This is the Codex analog of the Claude Code workspace-settings loading below
  and the **same class of trust decision**: registering a workspace for Codex
  sessions trusts its committed `.codex` configuration. In addition,
  `thread/start` durably records the workspace folder as trusted in the
  operator's `~/.codex/config.toml`
  (`projects."<path>".trust_level = "trusted"`), which also affects later
  interactive Codex use of that folder. What AgentRoom enforces around this:
  - **Explicit thread parameters win.** The operator-configured approval
    policy and sandbox mode are passed explicitly on `thread/start` — and
    identically on the `thread/resume` used to restore a session's thread
    after its child process is lost or idle-reaped — and cannot
    be changed by the workspace layer, and
    `sandbox_workspace_write.network_access` is pinned in both states (above)
    so the workspace cannot widen network access on fresh or resumed threads. Other nested sandbox keys
    (for example `writable_roots`) and workspace `mcp_servers`/hooks have no
    per-key shadow the backend could pin without enumerating the workspace's
    own config, so they remain part of the registration trust decision.
  - **Discovery stays inert.** Codex capability discovery (`model/list`)
    starts no thread, so it loads no workspace configuration and writes no
    trust entry — parallel to the isolated Claude Code discovery probe.
  - **No partial-isolation toggle.** There is deliberately no
    `CODEX_LOAD_WORKSPACE_SKILLS` analog: the app-server offers no switch that
    actually unloads repo skills or the project config layer
    (`project_doc_max_bytes = 0` would only drop `AGENTS.md`), and a toggle
    that delivered partial isolation would misrepresent the posture. Operators
    who do not trust a workspace's committed `.codex` configuration should not
    register it for Codex sessions.
- Claude Code turns default to `bypassPermissions`
  (`CLAUDE_CODE_PERMISSION_MODE`): the runner passes the SDK's explicit
  `allowDangerouslySkipPermissions` opt-in and turns are NOT sandboxed or
  filesystem-bounded to the registered workspace. This is a deliberate
  personal-use trade-off on the operator's own Mac and account; it is more
  permissive than the Codex `workspace-write` default. Stricter modes
  (`acceptEdits`, `dontAsk`, `default`) are selectable as a trust-tier managed
  setting, and the posture should be revisited when interactive permission
  approvals land.
- Claude Code sessions load the registered workspace's `project` settings source
  by default (`settingSources: ['project']` with `skills: 'all'`,
  `CLAUDE_CODE_LOAD_WORKSPACE_SKILLS`), so the workspace's `.claude/skills`,
  `CLAUDE.md`, and subagents are available to the session. This is the **whole**
  `project` source, not just skills: loading it also means the workspace's
  `.claude/settings.json` **hooks** and any `.mcp.json` **MCP servers** run
  automatically at session start (before any model turn), and its
  `permissions.*` rules and `env`/`apiKeyHelper` take effect inside the spawned
  CLI. Treat this as the **same class of trust decision as `bypassPermissions`
  itself** — you are trusting the registered workspace's committed configuration
  to run on your Mac:
  - **Automatic code execution.** A registered workspace's `SessionStart`/
    `PreToolUse` hooks and project `.mcp.json` stdio servers execute on session
    init without a model decision or a turn — a broader vector than the
    model-mediated shell that `bypassPermissions` already allows. Only register
    workspaces whose `.claude` configuration you trust.
  - **Billing is not guaranteed under this default.** The child-env scrub
    (below) removes `ANTHROPIC_*`/`CLAUDE_CODE_OAUTH_TOKEN` from the process
    environment, but a workspace `.claude/settings.json` can re-supply an
    `env.ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` or an `apiKeyHelper` that the
    CLI applies after the scrub, so a hostile workspace can bill an arbitrary key
    or run a credential helper. Deterministic billing holds only for workspaces
    you trust or with `CLAUDE_CODE_LOAD_WORKSPACE_SKILLS=false`.
  - **Gated to `bypassPermissions`.** Project settings load **only** at the
    default `bypassPermissions` posture (which is already fully permissive). Under
    a stricter configured `permissionMode` (`acceptEdits`, `dontAsk`, `default`)
    the runner forces isolation (`settingSources: []`) so a workspace's
    `permissions.allow`/hooks cannot silently widen the operator's chosen mode.
  - **Project scope only, and unbounded upward.** Only the `project` source loads,
    not the interactive CLI's `user` (`~/.claude`) or `local`
    (`.claude/settings.local.json`) sources — so this is **not** identical to an
    interactive `claude` run in that folder. Conversely, `CLAUDE.md` memory and
    `.claude/skills` are read from the cwd **and its ancestors**, so a workspace
    registered inside a larger repository also loads that parent repo's
    `CLAUDE.md`/skills — outside the registered-workspace subtree that the other
    read routes bound.
  - **Discovery stays isolated.** The capability-discovery probe (which spawns a
    session in the backend's own working directory, not a registered workspace)
    always forces `settingSources: []` and loads no skills, so a model-list read
    never executes the backend cwd's hooks/MCP servers.
  - Operators who need full SDK settings isolation (`settingSources: []`, no
    on-disk skills/CLAUDE.md/hooks/MCP) can set
    `CLAUDE_CODE_LOAD_WORKSPACE_SKILLS=false`. The effective value is reported by
    `GET /api/config` as `claudeCodeLoadWorkspaceSkills`.
  - Skill enablement is a context filter, not a sandbox: unlisted or unloaded
    skill files still exist on disk and remain reachable via Read/Bash, so skill
    files must not hold secrets.
- AgentRoom's own bearer token never reaches a spawned child. `AUTH_TOKEN` is the
  transport secret for the API, not something a coding agent, the MCP servers its
  project config layer starts, or an interactive shell has any use for, so it is
  removed from the environment of every child the backend spawns for a session:
  the Codex app-server (`codexChildEnv`), the Claude Code CLI
  (`claudeCodeChildEnv`, scrubbed in **both** auth postures because it is not a
  provider credential and the `CLAUDE_CODE_INHERIT_PROVIDER_AUTH` opt-in does not
  cover it), and the terminal PTY. The rest of the operator environment is still
  inherited, since each runner needs it to find its own credentials and tooling.
- Runner diagnostics that quote a child's own output are redacted before they
  leave the backend. The Codex runner keeps a bounded stderr tail so a startup or
  crash failure carries the child's explanation, but that text is the child's, not
  AgentRoom's: a config-parse error can quote a workspace `.codex/config.toml`
  line, including an `mcp_servers.*.env` value. The tail passes through the shared
  `util/redactSecrets` helper (bearer headers and labelled
  `token`/`secret`/`password`/`api_key` assignments) before it is appended to an
  error, because those errors surface on `GET /api/coding-agent/capabilities`, in
  turn-failure events, and in `/api/logs` and `/api/status` recent events — reads
  that are **not** bearer-gated (the global preHandler covers mutating methods
  only). Durable audit applies the same helper to `message`/`error` entries. The
  redaction is deliberately conservative — unlabelled high-entropy strings are
  indistinguishable from the thread ids, hashes, and paths that make the
  diagnostic useful — so it is defense in depth behind the environment scrub
  above, not a boundary.
- **DeepSeek Harness turns are `bypassPermissions`-class, and the posture that
  bounds them is the harness's own.** The `deepseek` runner drives an
  operator-installed DeepSeek Harness runtime over its first-party SDK JSON-RPC
  protocol (`apps/backend/src/runner/deepseek`). It is a bundled runner, so —
  unlike an external ACP adapter — it inherits the operator's environment and is
  configured through Keychain-backed bootstrap on the Mac rather than through a
  tier-3 JSON blob. What it does **not** inherit is a sandbox AgentRoom can
  describe:
  - **What bounds a turn is the operator's composition, and AgentRoom cannot
    read it.** The runtime boots the Cordis plugin graph named by
    `DEEPSEEK_CORDIS_CONFIG`, and that file — not this backend, and not the
    `permissionMode` below — decides whether the agent's filesystem and shell
    tools are confined. Upstream ships both answers: the vendor's own
    `examples/jsonrpc-agent/minimal.cordis.yml` mounts
    `sandbox-policy: mode: danger-full-access` and says in as many words that
    its Bash and absolute editor paths "can modify any path available to the
    runtime process", while the `dsh` CLI's profiles default to a
    `workspace-write` preset confining mutations to the session workspace and
    temporary roots. Nothing on the SDK wire reports which one is mounted, so
    AgentRoom does not claim to know: it treats this runner as
    `bypassPermissions`-class, the way the Claude Code default and the
    interactive terminal are read — a deliberate personal-use trade-off on the
    operator's own Mac — because that is the safe reading when the graph cannot
    be inspected. The permissive case is not hypothetical: the same harness,
    reached over ACP, wrote outside a registered workspace at its own default
    posture and raised no permission request
    (`docs/engineering/ACP_CONFORMANCE.md`). **Read the composition before you
    point at it.**
  - **Two environment values are pinned rather than left to the graph's
    fallbacks**, the same reflex as the Codex `network_access` pin, and for the
    same reason: a value AgentRoom depends on must be stated rather than assumed
    from a default an operator-authored file may have changed.
    - `DSH_CWD` is pinned to the registered workspace. The child's own cwd
      already is that directory, so this agrees with the stock
      `process.env.DSH_CWD ?? process.cwd()` fallback; what it buys is that a
      composition reading the variable cannot bind the agent's tools elsewhere.
    - `DSH_SESSION_ROOT` is pinned under `STATE_DIR`, the rule attachments and
      artifacts already follow. The stock compositions resolve persistence as
      `process.env.DSH_SESSION_ROOT ?? './.sessions'`, and that relative default
      is taken against the child's cwd — so unpinned, the harness writes its
      JSONL session log **into the registered workspace**, dirtying the working
      tree, appearing in the settle-time Git diff this runner derives, and
      sitting where a later commit could sweep it up.
  - **There is no interactive approval channel, by protocol.** The SDK wire
    documents server-to-client requests as a dead capability, so the adapter
    implements no `answerPermissionRequest` hook and the answer route's `404` is
    the honest reading for this runner. This does not preclude the bounded
    clarifying-question prompt contract described above: answering a question
    authorizes nothing and uses the question route, not the permission route.
    The only approval lever is the harness's own posture, carried as the
    tier-2 managed `runners.deepseek.permissionMode` and injected as
    `DSH_PERMISSION_MODE`. Its *vocabulary* belongs to the profile the runtime
    composes: AgentRoom bounds the shape, passes the value through, and does not
    claim to own the enum — so a client renders free text there rather than a
    closed picker, and the posture actually enforced is the composed profile's.
  - **Which runtime and which composition run are trust decisions the operator
    makes in the environment.** `DEEPSEEK_EXECUTABLE`, `DEEPSEEK_CORDIS_CONFIG`,
    and `DEEPSEEK_ARGS` are tier 3 — absent from the settings file, the
    `/api/config` metadata, and the PATCH schema by construction — because an
    executable path is "run this binary" and the composition selects which
    plugin graph, and therefore which tools, the agent has. The backend
    assembles argv itself; there is no shell. Both of the first two are required
    before `GET /api/runners` reports this runner `configured`: the runtime
    demands an explicit composition and exits nonzero without one, so an
    executable alone would advertise a runner that fails its first turn.
  - **The executable is the SDK runtime, never the `dsh` launcher.** `dsh` boots
    profiles (`--profile <name>`, `--profile headless "task"`, `web`, `plugin`)
    and has no entry mode that speaks this protocol; the serving bin is
    `dsh-jsonrpc-agent` or the packaged single-file runtime. This is a
    correctness point with a safety edge: a launcher pointed at here would start
    something — a web server on a listening port, most likely — rather than fail
    closed, so the adapter checks the wire-stable `initialize.serverInfo.name`
    and refuses a child that is not the SDK runtime.
  - **The harness can drive sub-agents, including other coding agents.** Those
    grandchildren inherit this child's environment and are processes AgentRoom
    neither bounds nor observes. The adapter ignores their session logs (it
    filters `session.event` to the session it owns), which is a correctness
    property, not a containment one.
  - **`AUTH_TOKEN` never reaches the child**, the same unconditional scrub every
    other spawned child gets, and for the same reason: it is the API's transport
    secret and would otherwise propagate into every process a turn spawns.
  - **A conversation is bound to its live DeepSeek runtime.** The protocol has
    no resume method, and reusing a session id in a fresh process may lazily
    create an empty agent/session pair unless the selected composition mounted
    persistence. The handshake cannot prove that persistence exists, so the
    descriptor declares `restoreStrategy: "unsupported"`: the shared host never
    idle-reaps the child, and cancellation or child loss makes that AgentRoom
    session uncontinuable. A later turn fails with an instruction to create a
    new session instead of silently losing the conversation.
  - **A released runtime is asked to stop before it is made to.** Teardown walks
    the ladder the protocol documents and the vendor's own client implements:
    the `shutdown` request (which flushes the response and disposes the root
    context so agents, subscriptions, and persistence reach quiescence), then
    stdin EOF, then `SIGTERM`, then `SIGKILL`, each rung bounded because each can
    be the one that hangs and the last one cannot. **Cancellation deliberately
    enters below the first rung**: `shutdown` drains to quiescence, which would
    let the work the operator just stopped run to completion, so a stop request
    closes stdin and signals instead. The ladder runs in the background — the
    session host frees its slot without waiting on a child that may not go
    quietly — and the same rungs reap the capability probe's throwaway child,
    because a runtime that ignores `SIGTERM` leaks whether or not anyone was
    talking to it.
- **Cursor turns are sandboxed by default, and the sandbox bounds writes and
  network, not reads.** The `cursor` runner drives the bundled `@cursor/sdk`
  inside a host child the backend spawns (`apps/backend/src/runner/cursor`,
  `docs/engineering/CURSOR_SDK_RUNNER.md`). Like Claude Code it is a bundled
  runner with a bundled credential path, so there is no executable to admit and
  `GET /api/runners` reports it `configured` without a bootstrap value. Posture:
  - **The sandbox is the tier-2 managed `runners.cursor.sandbox`, default
    `true`, and it is narrower than the vendor's reference says.** The run that
    settled it (fact 7 of the plan): with `local.sandboxOptions.enabled` a write
    outside the registered workspace failed, writes inside the workspace and
    under `/private/tmp` succeeded, network egress failed at DNS, and a read of
    a file in the home directory **succeeded**, `ls ~/.cursor/sdk` included. The
    vendor's reference says reads outside the workspace are blocked; this entry
    reports the run. So a sandboxed shell can read any file the operator can,
    the SDK's own `~/.cursor/sdk/auth.json` among them, and the bound is on
    what leaves the workspace and the Mac, not on what the model sees. Egress
    is allowlisted by the workspace's own `.cursor/sandbox.json`, which the
    workspace controls and AgentRoom cannot pin: the same class of clause as
    Codex's `.codex/config.toml`, except that Codex's `network_access` pin has
    no analog here. With `sandbox: false` the runner is
    `bypassPermissions`-class like the Claude Code default and the interactive
    terminal, in those words. The unsandboxed shell tool runs in the host
    process's cwd rather than `local.cwd`, so the adapter spawns the host with
    its cwd set to the registered workspace and the two agree either way.
  - **There is no interactive approval channel.** The SDK exposes no approval
    callback, so the adapter implements no `answerPermissionRequest` and the
    permissions route's `404` reads the absence of a channel. The configured
    posture is the only answer. `runners.cursor.autoReview` (tier 2, default
    `false`) turns on the vendor's server-side review classifier, which denies
    a blocked call rather than escalating it; it never widens. The
    clarifying-question channel is unaffected: it rides one custom tool whose
    callback the host relays to the backend, and answering authorizes nothing.
  - **Loading the workspace's `project` settings source is the tier-2
    `runners.cursor.loadWorkspaceSettings`, default `true`.** On, the SDK reads
    the registered workspace's `AGENTS.md`, `.cursor/rules/*.mdc`, the hooks in
    `.cursor/hooks.json`, the MCP servers in `.cursor/mcp.json`, and skills from
    `.cursor/skills`, `.agents/skills`, `.claude/skills`, and `.codex/skills`
    (fact 6: all four, and only the workspace's). Hooks and MCP servers take
    effect inside the turn, which is the same class of trust decision as Claude
    Code's `project` source; off passes `settingSources: []` and nothing on
    disk loads. The capability-discovery probe always forces `settingSources:
    []` in the backend's own cwd, so reading the model list never runs a hook.
  - **The SDK runs in a host child, and the child's environment is the scrub.**
    `@cursor/sdk` runs its agent loop inline in whatever process imports it, so
    the backend never imports it: it spawns `runner/cursor/host.js` with its own
    Node runtime and speaks JSON-RPC to it over stdio. The shell tool's children
    inherit the host's environment verbatim (fact 2), so what the host gets is
    what a turn's shell gets: the operator's environment minus `AUTH_TOKEN`, the
    same unconditional scrub every other spawned child gets. The agent's
    persisted state (the SQLite store `Agent.resume` continues from) is pinned
    under `STATE_DIR/cursor/agents`, never `~/.cursor/projects` and never the
    registered workspace. The `commandAudit` row names the Node runtime and one
    argument, never a workspace path and never a credential.
  - **Billing follows the sign-in, and the credential is tier 3.** A turn bills
    the Cursor account signed in through the SDK's web login
    (`~/.cursor/sdk/auth.json`, a minted user API key written `0600` with a
    90-day default lifetime), or `CURSOR_API_KEY` when set, which wins.
    `CURSOR_API_KEY` and `CURSOR_BACKEND_URL` are environment-only: absent from
    the settings file, the `/api/config` metadata, and the PATCH schema by
    construction, never logged, never returned, and never in an audit row. The
    host passes `apiKey` to the SDK only when the key is configured and
    otherwise passes nothing, so `HOME` stays the operator's. There is no third
    path: the `cursor-agent` CLI's own login is not read. The Mac's probe checks
    that the sign-in file exists and never opens it. An expired key surfaces as
    `ready: false` on `GET /api/runners` and an authentication error on the
    first turn; the remedy is running the sign-in again. `Cursor.auth.logout()`
    forgets the file but does not revoke the key; revocation is the dashboard's.
    A Cursor Pro plan or better is required; the SDK refuses a free account at
    `/v1/models` before anything runs.
  - **Turn settings are mapped, never passed through.** A turn's `model` is
    an id the catalog listed or the operator configured; `reasoningEffort` and
    `serviceTier` become `ModelSelection.params` under the parameter name the
    selected model declared (`effort` or `reasoning`, and the boolean `fast`),
    and a value the model does not offer fails the turn. `mode` (`agent` |
    `plan`) is not a setting in this release. Nothing a client sends reaches
    the SDK as a free string.
  - **Telemetry.** The SDK reports run lifecycle, latency, failure events, and
    feature-gate checks to Cursor under the API key's identity, with no opt-out
    the bundle exposes; repository identity in those events follows the Cursor
    account's privacy mode. Model inference leaves the Mac, as it does for every
    runner. If a later SDK adds an opt-out it belongs in the host environment,
    set unconditionally.
  - **Sub-agents are processes inside the host.** The `task` tool starts them,
    they inherit the host's environment, and AgentRoom neither bounds them
    separately nor observes them beyond the `task` message.
  - **Other runners' provider secrets reach this host**, as they reach every
    bundled runner's child: a Cursor turn's shell can read `DEEPSEEK_API_KEY`
    exactly as a DeepSeek turn's can read `CURSOR_API_KEY`. A per-runner scrub
    of the other runners' tier-3 names is a change to all four bundled runners
    and is listed under the plan's residuals rather than made here.
- Claude Code billing is deterministic for trusted workspaces: the runner scrubs
  `ANTHROPIC_*` and `CLAUDE_CODE_OAUTH_TOKEN` from the child environment so turns
  bill the Mac user's `claude login` subscription, unless the operator explicitly
  sets `CLAUDE_CODE_INHERIT_PROVIDER_AUTH=true` (or a loaded workspace
  `.claude/settings.json` re-supplies credentials, as noted above).
- Restorable persistent runner children are idle-reaped. Each AgentRoom
  session keeps one runner child process; for Codex, Claude Code, and Cursor,
  after 30 idle minutes the backend kills the child (matching the terminal's
  idle window), keeping the session's recorded native thread/session/agent id.
  The next turn — and any turn after a child crash, an unresponsive-cancel
  kill, or a backend restart, since the id is persisted with the session
  record and seeded back into the runner at startup — resumes that
  conversation (Codex `thread/resume`, Claude Agent SDK
  `resume`, Cursor `Agent.resume` from the store pinned under `STATE_DIR`) in a
  fresh child with the **same explicit runtime settings and isolation posture
  as a fresh start**: the Codex resume re-passes the operator's approval
  policy, sandbox mode, and pinned network access (verified against codex-cli
  0.146: resume applies explicit overrides and echoes the effective sandbox),
  the Claude resume rebuilds the same `settingSources`/permission-mode gating,
  and the Cursor resume is the same `agent/start` as a fresh one (model,
  sandbox, auto-review, settings source, question tool) with the kept agent id
  added. When a Cursor child dies or the cancel ladder must kill it with a run
  still active, the first resumed `agent/send` also sets the SDK's local
  `force` recovery flag; idle-reaped sessions do not need it. A
  rejected resume (for example a thread with no recorded turn, which has no
  rollout) falls back to a fresh thread rather than failing the turn. Deleting
  an AgentRoom session forgets its resumable id, so an explicitly deleted
  thread is never silently resumed. Those adapters get this from one
  implementation (`runner/shared/PersistentRunnerSessionHost.ts`) rather than
  two parallel ones, and each declares how it can be restored
  (`native_resume`, `history_replay`, `unsupported`). The host arms an idle
  timer **only** for a runner it can restore: reaping a child that cannot be
  restored would silently begin a fresh conversation under the same AgentRoom
  session id, which is a worse outcome than a long-lived idle process. Codex
  and Claude Code are `native_resume`; DeepSeek is `unsupported`, stays resident
  while idle, and refuses same-session continuation after cancellation or child
  loss.
- The interactive terminal (PTY) is the **one deliberate exception to "no
  arbitrary shell execution"**, and it is **off by default**. It is the
  client-driven analog of the Claude Code `bypassPermissions` posture: a real
  login shell the operator can drive from a client, **unsandboxed and not
  filesystem-bounded** to the registered workspace once running. It is gated by
  `TERMINAL_ENABLED` (default `false`); when unset the WS route is **not
  registered at all**, so the surface is entirely absent. It is a **tier-2
  managed setting**, so turning it on from a paired client additionally requires
  the Mac-side `REMOTE_SETTINGS_ADMIN` switch and a backend restart; the
  environment variable still wins and locks the key. Posture when enabled:
  - **Bounded start, not bounded run.** The shell is spawned with `cwd` set to the
    `realpath` of a registered workspace (rejecting an unregistered or missing
    workspace), so it always *starts* inside a registered workspace. It is a real
    shell, so it can then `cd` elsewhere — the bound is the starting directory and
    the registered-workspace gate, not a sandbox. This is strictly more permissive
    than the Codex `workspace-write` default and on par with the Claude Code
    `bypassPermissions` default; it is a personal-use trade-off on the operator's
    own Mac and account.
  - **Bearer-authed channel.** `WS /api/workspaces/:workspaceId/terminal` performs
    its **own** bearer check in-handler (`authorizedForRead`), because the global
    preHandler only gates mutating *HTTP* methods and a WS upgrade is a GET. A
    missing/incorrect token when `AUTH_TOKEN` is configured gets an `error` frame
    and an immediate `1008` close — before any shell is spawned. (Note: the
    pre-existing `WS /api/events` stream is not yet bearer-gated; that gap is
    tracked separately and is intentionally **not** changed by this slice.)
  - **No shell I/O is ever logged, returned, or persisted.** Keystrokes and output
    can contain secrets, so they live only on the live socket. The
    `terminal_session_started`/`terminal_session_closed` events and durable audit
    entries carry only `sessionId`, `workspaceId`/`workspacePath`, and (on close)
    `exitCode` and `durationMs` — never frame bytes.
  - **Bounded lifecycle.** The global per-process session cap is operator-configurable
    (`TERMINAL_MAX_SESSIONS`, default 8, schema-bounded 1–64) and applies across all
    workspaces. A client may hold several sessions for one workspace — across several
    terminal windows, since the visionOS client can move a tab between windows, which
    transfers the live session and never spawns one — but every create
    reserves a slot before the async workspace lookup, so concurrent upgrades cannot
    race past the cap. Idle sessions are reaped (timer reset on input, output, and
    resize, so an active-but-quiet session is not killed), resize frames are clamped to
    a sane range, and every shell is killed (`SIGTERM`) when its socket closes, when the
    session is reaped, or on backend shutdown. Output is flow-controlled — the PTY is
    paused when the WebSocket send buffer grows and resumed when it drains — so a fast
    producer with a slow client cannot balloon backend memory, and a single inbound
    frame is size-capped.
  - **Environment.** The shell inherits the backend user's environment plus
    `TERM=xterm-256color`, like opening Terminal.app, with one exception: AgentRoom's
    own bearer token (`AUTH_TOKEN`) is scrubbed from the PTY environment so it does not
    leak into the shell or its subprocesses (a client already holds that token to reach
    the route, but Terminal.app would not carry it). The resolved shell path
    (`TERMINAL_SHELL`, else `$SHELL`, else `/bin/zsh`) is never returned by
    `/api/config`: it is a tier-3 key, so it is absent from the managed settings
    file and from the metadata block by construction. The switch itself and the
    session cap are tier-2 managed settings and *are* reported there — a client
    that may offer the terminal has to be able to see whether it is on.
- Agent turn context accepts only selected workspace-relative paths; the backend
  resolves and bounds previews before injecting them into runner prompts.
- Backend turn context assembly is limited to the original user message,
  explicit workspace context paths, and session-scoped attachment ids; it does
  not perform automatic file selection, embeddings, summarization, token
  budgeting, or arbitrary binary file handoff.
- Session attachments accept only uploaded PNG, JPEG, or WebP image files for
  the first slice. The backend validates type/signature, hashes content, stores
  files under `STATE_DIR`, and attaches them to turns by session-scoped id
  without writing into the registered workspace. Session deletion removes that
  session's backend-owned attachment storage.
- Live artifacts are model-authored sketches streamed in-band as an
  `<artifact kind="svg|mermaid">` region of assistant text. The backend parser
  only opens a region for an `<artifact …>` tag at the start of a line (matching
  the prompt contract), so an inline `<artifact …>` the model is merely quoting
  in prose is left untouched rather than silently swallowing the surrounding
  text; the close marker tolerates surrounding whitespace and case
  (`</artifact >`, `</Artifact>`) and a self-closing `<artifact …/>` is dropped
  as an empty control tag, so a slightly malformed tag bounds the region instead
  of consuming the rest of the turn. Regions are parsed and stored backend-side
  only: bounded per session (count cap) and per artifact (a 64 KB UTF-8 byte cap,
  trimmed on a code-point boundary and flagged `truncated`), in-memory, released
  on session deletion, and never written into the registered workspace. The live
  delta stream only carries what the store actually retained, so it never exceeds
  the cap or diverges from the reconnect snapshot. Only `svg` and `mermaid` kinds
  are accepted; other kinds are left as ordinary chat text. The channel is gated
  by `ARTIFACTS_ENABLED` (default on). Because artifact content is model-authored
  markup, any client that renders it must sandbox the render surface. The
  visionOS client does this per kind: SVG renders in a `WKWebView` with
  JavaScript disabled, and Mermaid (which requires JavaScript) renders with a
  vendored, bundled `mermaid.min.js` that is never fetched from the network and
  is injected as a `WKUserScript`. Both surfaces share one
  Content-Security-Policy, `default-src 'none'; style-src 'unsafe-inline';
  img-src data:`: `default-src 'none'` is the fallback that blocks every network
  fetch, connection, font, frame, and subresource (so an `<image href>`/`<use
  href>` or CSS `@import` cannot phone home — disabling JavaScript alone does not
  stop those requests, the CSP does), `style-src 'unsafe-inline'` permits the
  inline page styles, and `img-src data:` allows only inline `data:` images,
  which are not network requests. On the Mermaid surface the injected user script
  runs regardless of CSP (that is how Mermaid renders), but the same
  `default-src 'none'` still blocks every document request. The untrusted Mermaid
  diagram source is only ever handed to Mermaid in `securityLevel: 'strict'`
  (DOMPurify-sanitized output, no HTML labels, no click bindings) with
  `suppressErrorRendering` so partial mid-stream source cannot inject markup, and
  it is passed via `evaluateJavaScript` as a JSON-encoded string literal (never
  interpolated into HTML), so it cannot break out into script. In both renderers
  no base URL is set and the navigation policy allows only our own host-less,
  in-memory `loadHTMLString` loads (`about:blank`); any other navigation — link
  taps, redirects, form submits, or a script-initiated navigation to a hosted
  URL — is cancelled, so model markup cannot reach the host or the network even
  if a renderer-level check were bypassed. The shared CSP, web-view
  construction, render scheduling, and navigation policy live in one place
  (`SandboxedWebView.swift`) so the boundary cannot drift between the two
  surfaces. HTML-with-JS and 3D artifact kinds are intentionally not supported.
- The visionOS code editor is an **interactive, editable** web view, distinct from
  the read-only artifact surfaces above. It renders the vendored Monaco editor,
  served to the web view only from the app bundle by a private `agentroom-editor://`
  `WKURLSchemeHandler` (`MonacoSchemeHandler`) that returns files solely from the
  bundled `Resources/Monaco` directory — never the network or the workspace. It is a
  deliberate, documented divergence from the artifact surfaces' read-only
  `SandboxedWebView` CSP, which has no `script-src` because those surfaces run no page
  scripts.
  - **CSP.** The page runs under a strict `default-src 'none'` Content-Security-Policy.
    Each fetch directive names the editor's own origin as `'self' agentroom-editor:` —
    the custom scheme is listed explicitly because WebKit does not reliably match a
    `WKURLSchemeHandler` origin against bare `'self'`:
    - `script-src 'self' agentroom-editor: 'wasm-unsafe-eval'` — the editor's own
      bundled scripts, including the vendored `vscode-textmate` highlighting engine;
      `'wasm-unsafe-eval'` compiles the bundled Oniguruma regex WASM that engine runs.
    - `style-src 'self' agentroom-editor: 'unsafe-inline'` and `font-src 'self'
      agentroom-editor: data:` for Monaco's runtime-injected CSS and inline icon font;
      `img-src 'self' agentroom-editor: data:`.
    - `connect-src 'none'` blocks any fetch/XHR/WebSocket; `worker-src data:` covers the
      single inert no-op `data:` worker (workers are disabled; tokenizing runs on the
      main thread); `child-src`, `base-uri`, `form-action`, and `object-src` are all
      `'none'`.
  - **Navigation.** The navigation policy allows only the editor origin and a host-less
    `about:blank` and cancels everything else (including host-less `file:`/`data:`/`blob:`
    URLs), so file content cannot leave via a redirect, link, or scripted navigation.
  - **Bridge and untrusted input.** The native↔web bridge accepts only the whitelisted
    message types (`ready`, `change`, `findResult` — match counts only: `total`, `index`,
    and `limited`, never matched text, matched lines, or file content — and the
    diagnostic-only `fatal`/`log`, which can drive the editor to a failure overlay or write
    to Console but carry no file content); the only untrusted input — the file's text — is
    injected as a JSON-encoded JavaScript string literal, never interpolated into HTML.
  - **No new mutation path.** Edits stream back to the model and save only through the
    existing single bounded write (`PUT /api/workspaces/:id/file`).
  - **Side-by-side diff view stays inside the boundary.** The editor can toggle a read-only
    two-pane diff (git HEAD baseline on the left, the working buffer on the right) rendered by
    two plain Monaco editors — not Monaco's own diff editor, which needs the editor worker this
    app stubs out. Unlike the gutter quick-diff bridge (`__setGitDiffDecorations`, line numbers
    and kinds only), the diff view's `__showDiff` bridge call injects the HEAD baseline text into
    the page. That is the **same class of data as the working buffer the page already holds** —
    committed bytes the client already fetched over the bearer-authed, bounded
    `GET /api/workspaces/:id/git/file-base` read (which reuses the preview path's lexical
    bounding, secret-name refusal, NUL/binary rejection, and 256 KB cap) — and it is injected as
    JSON-encoded string arguments, never interpolated into HTML. The page keeps
    `connect-src 'none'` and the editor-origin-only navigation policy, so neither the baseline
    nor the working text can leave. The diff alignment (`GitDiffHunk`) carries only line
    numbers/counts and a kind. It is read-only and opens no new write or fetch path.
  - **Find in file is native chrome over a literal search.** The search UI is a **native**
    window ornament, not web chrome, so the untrusted query never becomes page markup: it
    crosses to the page as a **JSON-encoded JavaScript string argument** to `__findInFile`
    (the same injection discipline as the file text), never interpolated into HTML. The
    search itself is **literal only — Monaco's `isRegex` is hard-coded false** — so a query
    is never compiled as a pattern, and results stop at a 1,000-match cap that is reported
    as a `limited` flag. The remaining bridge calls carry no content either: `__findGoTo`
    takes a match ordinal, `__findClear` takes nothing, and `__revealLine` takes only
    clamped 1-based line/column geometry. This opens **no new read, write, or network
    path** — no route is called, `connect-src 'none'` and the editor-origin-only navigation
    policy are unchanged — and replace-in-file is deliberately not implemented. Any future
    replace must go through the existing single bounded write
    (`PUT /api/workspaces/:id/file`), not a page-side buffer mutation.
  - **Highlighting is data, not code.** The vendored Oniguruma WASM, the
    `.tmLanguage.json` grammars, the scope-based token themes, and the VS Code language
    configurations (brackets, comments, auto-closing) are read from the app bundle by
    native and injected over the bridge (the page is `connect-src 'none'`, so it cannot
    fetch them); the web view runs the vendored engine but never loads a language as
    executable script, and when those assets are absent it degrades to Monaco's built-in
    Monarch highlighting and default editing behavior.
- The visionOS editor can source its language assets from a **backend-served language
  catalog** (Phase C) instead of only the app bundle, so new/updated grammars, themes,
  and language configs ship without an app update. This stays inside the existing
  boundaries:
  - **App/global data, not workspace files.** The assets are served by two new bounded
    read routes (`GET /api/editor/catalog` manifest + `GET /api/editor/catalog/asset`)
    that **never touch a registered workspace or the workspace file API**. Both require
    the bearer token when `AUTH_TOKEN` is configured (via `authorizedForRead`).
  - **Data only, never executable code.** The catalog serves `.json` and `.wasm`,
    enforced by an extension allowlist, and only paths the manifest references; it
    **never serves executable code** (`.js`/Monarch language packs) — the TextMate engine
    JS stays bundled in the app, same-origin under the editor's `script-src 'self'`. The
    asset route reuses the workspace read bounding (lexical normalize, realpath
    containment, symlink-leaf refusal).
  - **Gated and absence-safe.** The routes are gated by `LANGUAGE_CATALOG_ENABLED`
    (default on; not exposed in `/api/config`); when the curated
    `apps/backend/catalog-assets/` directory is absent the manifest is null and the
    routes 404.
  - **Webview stays no-network.** The editor WKWebView keeps `connect-src 'none'`: native
    fetches the catalog over REST and injects it over the existing bridge, exactly like
    the bundled path — the webview, `MonacoSchemeHandler`, and the page CSP are unchanged.
  - **Hash-verified, bundled fallback.** The client **verifies every fetched blob's
    sha256** against the manifest before use and caches assets content-addressed on
    device; **bundled assets remain the offline fallback**, so a malformed, tampered, or
    absent catalog degrades to bundled rather than breaking the editor.
- The editor language catalog directory is **operator-managed and reloadable** (Phase C.5),
  so an operator can push a new/updated catalog from the macOS app **without rebuilding the
  backend**. This does not widen the catalog's boundaries — it only makes its source
  configurable and re-readable at runtime:
  - **Configurable root, same bounding.** The served directory resolves
    `EDITOR_CATALOG_DIR` (default `$AGENTROOM_HOME/catalog-assets`) and prefers it when it
    holds a manifest, else the **bundled** `apps/backend/catalog-assets`, else no catalog
    (routes 404 → client uses its bundled floor). Whichever root is chosen, the asset route
    keeps the **same read bounding** (lexical normalize, realpath containment, `.json`/`.wasm`
    extension allowlist — never `.js`, symlink-leaf refusal, manifest-referenced paths only).
    The catalog root is **never a registered workspace** and never routes through the
    workspace file API; reads stay bearer-authed via `authorizedForRead`.
  - **Reload route.** `POST /api/editor/catalog/reload` re-reads the directory and swaps the
    in-memory manifest. It is a mutating method, so the global preHandler **requires the
    bearer token when `AUTH_TOKEN` is configured**; it is gated by `LANGUAGE_CATALOG_ENABLED`
    and performs **no workspace mutation**. `GET /api/editor/catalog/status` (a bearer-gated
    read) reports only the live source/version/language-count for the operator UI.
  - **New writable surface (operator-side).** The macOS Languages pane imports an
    operator-chosen folder by copying its **data files only** (`.json`/`.wasm`, never `.js`,
    a clean replace) into the app-managed `$AGENTROOM_HOME/catalog-assets`. This is the one
    new write, and it targets AgentRoom's **own app-support directory on the operator's Mac**
    — not a registered workspace and not an arbitrary path. The TextMate engine JS stays
    bundled in the app, so the served catalog can still never carry executable language packs.
  - **Auto-propagation carries no content.** A reload that changes the aggregate version
    publishes an `editor_catalog_changed` event over `WS /api/events` carrying only
    `{version, languageCount}` — never asset bytes. visionOS re-hydrates on receipt and still
    **verifies every fetched blob's sha256** before use, so a malformed or tampered push
    degrades to the bundled floor rather than reaching the editor.
- The spatial render engine adds **no new execution or write surface**.
  Geometry-first scenes (`<name>.scene.json`) and semantic solution diagrams
  (`<name>.diagram.json`) are ordinary workspace files; human placement lands
  only in their sibling `*.human.json` layers through the existing bounded,
  optimistic-locked `PUT /api/workspaces/:id/file`. The single
  `GET /api/workspaces/:id/spatial-scene` read dispatches both suffixes through
  the explorer's existing lexical bounding, symlink containment,
  secret/generated filtering, and 256 KB cap, and requires bearer auth when
  configured. Scene documents keep their 64-entity numeric caps and structured
  4xx validation failures. Diagram documents are strictly zod-validated with
  64-node / 128-edge / 16-group caps; schema/reference failures return a
  bounded `{ errors }` render document, while unknown role/kind vocabulary
  degrades to generic primitives plus bounded warning strings rather than
  disabling the whole diagram. The diagram override layer's `collapsed` flag
  (group entries only, added for group collapse/expand) changes only which
  bounded entities compose — a collapsed group emits one stand-in instead of its
  members — and adds no route, event, or write path. A collapsed member that was
  already hidden contributes only its bounded source id and label to
  `suppressedHiddenEntities`, so the existing restore ornament can undo that
  hide without treating it as renderable geometry; an unknown override field is
  still refused by the strict schema. `staleOverrides` is the same class of
  bounded, non-renderable metadata: one entry per override whose id the base
  document no longer declares, carrying that entry's own id and adjustment flags
  and nothing else — no label, no coordinates, and no id the two files did not
  already hold. It is derived at compose time from the same two bounded reads and
  is bounded by the override layer's own cap, and it neither deletes the entry
  nor adds a way to; discarding an orphaned adjustment is the client rewriting
  the override layer through the existing optimistic-locked PUT, so this adds no
  route, event, or write path either. The service keeps **no state**: it composes on
  every read, with no watcher, tracked-scene registry, or new event type;
  clients reuse `workspace_file_written`, `workspace_file_deleted`,
  `workspace_directory_deleted`, `workspace_entry_renamed`, and turn settlement
  signals. While
  Named flows (base `schemaVersion: 2`, optional `flows`) are bounded the same
  way — 16 flows of at most 32 steps, each step an id that must reference a
  declared edge — and compose resolves them to already-composed connector ids,
  so they add no geometry, no id the document did not already carry, and no
  client-side lookup. Choosing one is view state in the volume: it writes
  nothing, so unlike lock, hide, and collapse it never reaches the override
  layer or the bounded PUT. Descriptions (base `schemaVersion: 3`, optional
  bounded `description` on the document, nodes, edges, and groups, ≤ 500
  characters each, trimmed) are the same class of additive, versioned field:
  compose passes them through to the composed entities, connectors, and
  document verbatim — file content the composed read already serves, no new
  data class — and the selection card renders them. Declaring one below
  version 3 is a validation error, so the version stays an honest capability
  marker. A document that declares an older version stays valid and simply
  composes an empty `flows` and no descriptions, so an older committed diagram
  is not turned into an error card by either bump. While
  `SCENE_ENGINE_ENABLED` is on, the backend injects one constant authoring
  contract into Codex turn prompts and appends the same stable string to Claude
  Code's SDK system prompt. The contract frames diagrams as an on-request
  capability and forbids edits to `*.diagram.human.json`. The composed result is
  bounded data for native RealityKit rendering; no model-authored markup or
  script executes. Disabling the flag unregisters the route and omits every
  prompt-delivery path.
- The Mermaid import bridge (`POST /api/spatial-scene/mermaid-import`) is the
  spatial surface's one **pure-compute** route, and it deliberately touches
  nothing: no workspace, no filesystem, no child process, and no execution of
  mermaid.js or any other model-authored markup — conversion is a hand-rolled,
  bounded, single-pass parser in `src/scene/diagram/mermaidImport.ts`. Posture:
  - **No caller input is ever compiled into a RegExp.** The module's few regex
    literals are fixed and applied to length-bounded text; everything
    structural is character scanning, so a hostile source degrades to a
    structured error rather than an in-process ReDoS — the same reasoning that
    keeps regex out of the content search.
  - **Bounded at every step.** The request `source` is capped at 64 KB (the
    artifact content cap; the route answers `413` past it), the parser bounds
    lines and line length, the emitted document is capped by the diagram
    schema's own 64-node/128-edge/16-group limits (over-cap is a structured
    error, never silent truncation), and warnings/errors are count-capped.
  - **It converts; it never writes.** The response is canonical `.diagram.json`
    text the *client* writes through the existing bounded, optimistic-locked
    workspace file PUT — create-only (no `baseModifiedAt`), so an import
    cannot overwrite an existing diagram. No new write surface, no event, no
    audit entry, no state.
  - **Gated and bearer-authed.** Registered only while `SCENE_ENGINE_ENABLED`
    is on (off ⇒ the route is absent), and as a mutating POST the global
    preHandler requires the bearer token when `AUTH_TOKEN` is configured; the
    handler does not double-authenticate.
  - **Deterministic, and lossy edges are reported.** Identical input produces
    identical output, and every conversion loss (a sanitized id, a dropped
    self-loop or subgraph-endpoint edge, a flattened nested subgraph) is a
    bounded warning — a renamed id matters because human overrides key on
    diagram ids, so the warnings are what keep a re-import from silently
    orphaning placement.
- The diagram edit route (`POST /api/spatial-scene/diagram-edit`) is the import
  bridge's sibling and inherits its posture wholesale: **pure compute** — no
  workspace, no filesystem, no child process, no caller input compiled into a
  RegExp — that converts and never writes. It applies a bounded, zod-typed
  list
  of semantic operations (at most 32) to base document text (capped at the
  256 KB file write cap) and returns new canonical `.diagram.json` text the
  *client* writes through the existing bounded, optimistic-locked workspace
  PUT, passing the base layer's `modifiedAt` token from the composed read it
  edited against — so a concurrent agent regeneration surfaces as the PUT's
  `409`, never as a lost update, and the route itself adds no write surface,
  event, audit entry, or state. What it will not do is as deliberate as what it
  does:
  - **No rename-id op.** Ids are the keys human overrides attach to (the
    `staleOverrides` mechanism exists because a changed id orphans them), so
    the op vocabulary edits labels and the backend derives created ids from
    them with the shared sanitizer and a deterministic collision ladder. A
    client edit therefore cannot orphan placement the way an agent rename can.
  - **All-or-nothing, never a partial apply.** The first inapplicable op fails
    the whole request with a bounded op-indexed `422`; the document caps
    (64 nodes / 128 edges / 16 groups) are enforced at op time as structured
    errors, never silent truncation. Knock-on effects of a delete (incident
    edges, flow steps, ungrouped members) are bounded warnings, never silence.
  - **Gated and bearer-authed.** Registered only while `SCENE_ENGINE_ENABLED`
    is on (off ⇒ the route is absent), and as a mutating POST the global
    preHandler requires the bearer token when `AUTH_TOKEN` is configured.
  - **Deterministic and canonical.** Identical input produces identical output
    through the same canonical serializer the import uses
    (`diagram/canonical.ts`), so the two conversion surfaces cannot drift apart
    byte-wise and a no-op edit round-trips cleanly.
- Two things the backend puts in a turn prompt are **not** constant. Both are
  diagram-scoped, bounded at every step, gated by `SCENE_ENGINE_ENABLED`, held
  only in memory per session, and delivered once per accepted turn to both
  runner kinds; each keys on the one authorship signal that already exists for
  its author, so neither adds a watcher, a scan, an event type, or a route. The
  first is the
  human-edit summary (Phase 5 slice 1, widened by Phase 6 slice 6) — a bounded
  line naming what the human changed in a diagram since that session's last
  turn: placement adjustments in its `*.diagram.human.json` layer, structure
  edits to the `*.diagram.json` base document (the writes the diagram-edit route
  produces), and the override ids left orphaned when the base document no longer
  declares them — the prompt-side counterpart of the composed read's
  `staleOverrides`, which is how an agent learns its own earlier rename orphaned
  a human adjustment. It is gated by the same `SCENE_ENGINE_ENABLED` flag, and it
  is deliberately the narrowest thing that closes the salience gap the always-on
  contract leaves:
  - **It is derived from the written diagram's own two files alone**, never from
    the workspace tree or any other file. The override layer holds semantic ids
    plus bounded placement-state fingerprints; the base document is the design
    the agent authors, reads, and is being asked to edit. The summary names ids
    and change categories only — no labels, no description text, no
    coordinates, no file content, and
    no data class the agent could not already reach with the Read the standing
    contract already instructs. Because the delta is computed against the state
    this session was last shown, an out-of-band edit the event stream never
    announced can fold into the next human delta; the contract's re-read rule
    remains the floor for anything the summary does not see.
  - **It is bounded at every step**: at most 4 diagrams per turn (the rest
    reported only as a count), 8 ids per category, and a 1200-character cap, over
    at most two reads per tracked diagram (base and override, at most 16 per
    workspace) that go through the explorer's bounded preview path like every
    other workspace read.
  - **It reads only what a bounded PUT announced.** The tracker subscribes to the
    existing `workspace_file_written` event — the client's own writes to a
    diagram's two layers are its only source, and agent file edits publish no
    event, which is the entire authorship discrimination — so it adds no
    fs-watcher, no new event type, no scan of the
    workspace on the turn-start path, and no tracked-open state. A file that
    cannot be read, or that fails its strict schema, is skipped silently
    rather than relayed into a prompt or failed onto a turn.
  - **It is per-session and delivered once.** Session pointers and compact
    per-layer snapshots are in-memory, bounded, and released on
    `agent_session_deleted`; nothing about a human edit is persisted, audited,
    or emitted. The pointer advances only after turn input validation succeeds,
    so a rejected turn leaves the summary available to retry. Unlike the contract, the summary goes into
    the **turn** prompt for both runner kinds, because a value that changes
    between turns cannot live in Claude Code's stable, cached system prompt.
- The second non-constant prompt injection is the diagram render feedback
  (visual-refinement Phase 6 slice 1) — a bounded line telling the agent what
  the `*.diagram.json` documents its own last turn wrote actually rendered as:
  compose warnings (an unknown role or edge kind falling back to the generic
  treatment), validation errors (the state the volume shows as an error card),
  or the over-cap state. Without it the agent authors blind — those outcomes
  surface only in the volume, and the human has to relay them by hand. It is
  the human-edit summary's mirror image, and deliberately narrow the same way:
  - **It keys on turn settlement, never on `workspace_file_written`.** That
    event is the human-edit tracker's authorship discrimination (only the
    bounded PUT publishes it; agent writes never do), and this channel needs
    the opposite author. The agent-authorship signal that already exists is
    the settling turn's own `coding_diff_updated` file summary — the
    settle-time Git delta for Claude Code, Codex's own `turn/diff/updated` —
    so a `*.diagram.json` base path among its files is what triggers
    validation. No fs-watcher, no new event type, no route, and no scan of the
    workspace; the diff's documented attribution caveat (a concurrent human
    write during a turn is attributed to the turn) is inherited knowingly, and
    the read reports what is actually on disk either way.
  - **It reads at most a handful of bounded previews at settlement, off the
    turn-start path.** At most 4 diagrams per settled turn get one read each
    through the explorer's bounded preview (writes beyond that are reported
    only as an unchecked count); validation is the same zod schema and compose
    pass the read route runs, so the reported strings are exactly the bounded
    `warnings`/`errors` the composed read already serves the volume — no new
    data class reaches a prompt. A read failure is skipped silently, a clean
    render clears any pending report for that diagram, and a diagram the diff
    reports deleted — or renamed away, via the diff entry's `oldPath` — drops
    its pending report rather than relaying a stale one.
  - **It is per-session, ordered, delivered once, and never persisted.**
    Settlement validations are serialized per session, and the next turn's
    prompt assembly waits out the in-flight chain — waiting never starts a
    read, so the turn-start path stays read-free while an immediately queued
    follow-up turn still carries the previous turn's feedback, and an older
    settlement can never record over a newer one. Outcomes wait in memory
    keyed by session (bounded per session and across sessions), ride the next
    accepted turn's prompt for both runner kinds, and are consumed only when
    the turn is accepted **and** the report's line actually fit under the
    summary's character cap — a rejected turn retries with them, and a report
    the cap squeezed out stays pending for the turn after. Everything is
    released on `agent_session_deleted`, which also cancels any validation
    still in flight so a completing read cannot recreate a deleted session's
    state. Nothing is audited, emitted, or returned by a route.
  - **A human's broken edit is not double-reported.** The diagram-edit route
    rejects an inapplicable op list with a `422` the client already surfaces,
    so it never lands on disk and never reaches this channel; what lands
    through the bounded PUT during a turn is subject to the attribution
    caveat above, nothing more.
- Rendering a spatial document on a **real surface** (the visionOS client's
  mixed immersive space) adds no surface class either. It is a second
  presentation of the document the volume already holds: the same composed read,
  the same shared renderer, and the same `*.human.json` writes through the same
  bounded, optimistic-locked PUT — it adds no route, event, contract field, or
  backend state, and the backend cannot tell the two presentations apart. It
  also takes **no new device capability**. Anchoring uses RealityKit's own
  (`AnchorEntity(.plane(.horizontal, classification:, minimumBounds:))`), where
  the system resolves the surface and the app is never handed the plane:
  AgentRoom opens no `ARKitSession`, requests no world-sensing authorization,
  ships no sensing usage-description string, and receives no room geometry,
  scene mesh, or hand data. When no surface resolves, the fallback places the
  content once relative to the head pose (`trackingMode: .once`) and then stops
  tracking, so the client neither follows the wearer nor records where they
  were. Nothing about the room is read, stored, or sent anywhere.
  The scale presets layered on top change none of that. A preset is a container
  size plus the surface classification and minimum bound that size implies, so
  choosing one changes **which** surface the system is asked to resolve and how
  far a drag may travel — not what comes back, which is still nothing. Asking
  for the placement again rebuilds the same anchors; it reads no more of the
  room than the first attempt did. The preset is client state held on
  `AppStore`: it reaches no `*.human.json` layer, no route, no event, and no
  contract field, so the backend composes the identical document at every scale
  and cannot tell which one is rendering.
  The room's memory across app launches adds no data class either, because the
  thing that would have been a new one is the thing it deliberately does not
  store. What persists is the placement *choice* — the scale preset, and the
  workspace id plus workspace-relative path of the document that was left
  resting — written to the app's own `UserDefaults` on the device. The **spot is
  not stored, and could not be**: RealityKit's anchoring resolves the surface
  system-side and hands the app no plane, transform, or identity, and the only
  visionOS API that remembers a physical point across launches is an ARKit
  `WorldAnchor`, which needs the `ARKitSession` this posture rules out. So a
  restored room re-runs the same surface search from where the person is
  standing now and reads no more of the room than a first placement does;
  nothing about the room is recorded, and nothing leaves the device. The stored
  document reference is the same class of local preference as the server URL
  beside it — a path, never file content — and it reaches no workspace file, no
  request, and no event, so the backend cannot tell that a room was ever
  remembered.
- The visionOS client derives file context from explicit `@` file mentions in
  the turn composer; browsing and previewing workspace files does not add turn
  context by itself.
- The visionOS client can upload selected Photos images or pasted clipboard
  images, including copied screenshots, as session attachments, but it only
  sends backend attachment ids on the turn; backend turn context assembly
  resolves the ids and runner input parts.
- Durable audit persists only sanitized lifecycle and runner audit entries.
- The macOS app strips the AgentRoom-managed and secret-tier env vars it owns
  from the inherited environment before launching the backend, so a value
  exported by whatever launched the app cannot silently lock a managed key or
  shadow a Keychain-held secret. The secret-tier half of that list is derived
  from the bundled bootstrap descriptors, so the names it strips and the names it
  injects are the same set by construction. Exported diagnostics follow the
  opposite rule on purpose: redaction walks every *stored* slot value rather than
  the descriptor allowlist, since an unknown value must still never reach an
  exported bundle, and the status block reports only whether each slot is
  configured — never what it holds. It is not a credential filter for the operator's
  wider environment: unrelated developer credentials are inherited by the backend
  and, as documented above, by the children it spawns (minus `AUTH_TOKEN` and,
  for Claude Code, the provider credentials it scrubs).
- The macOS app's Claude Code sign-in readiness check is a presence-only login
  Keychain lookup for the `claude login` credential (service
  `Claude Code-credentials`). It requests no item data, never reads, returns, or
  logs the credential value, and runs only locally on the operator's Mac.
- The macOS app can signal a backend sidecar it did not spawn, and what bounds
  that is the identity it recorded rather than the pid alone. A sidecar outlives
  an app that was force quit or crashed — `applicationWillTerminate` never runs,
  and the child is reparented to launchd — so the app records each launch's pid,
  kernel process start time, executable path, and port, and a later session
  adopts that process only when every field still matches **and the same process
  owns a listening TCP socket on the configured backend port**. `Process` cannot
  attach to a pid it did not create, so the stop is `kill(pid, SIGINT)` and then
  SIGTERM, the same ladder the owned path uses. Pids are recycled, so the
  identity is re-checked immediately before `kill` inside the signal call rather
  than at the call site. That rejects a record already known to be stale.
  Darwin does not provide this app a stable process handle that atomically binds
  an arbitrary pid's start identity to signal delivery, so there remains a
  narrow race if the recorded process exits and its pid is reused between that
  re-check and `kill`; this recovery path accepts that local residual risk
  rather than granting a broader helper or privileged process-control surface.
  The record is the app's own local supervision state, in its defaults and
  nowhere the backend reads; it holds no secret and describes a process on the
  operator's own Mac.
  A backend the app did not start has no record, is never adopted, and is never
  signalled — the app reports it as running outside itself and leaves it alone,
  because the operator's own `pnpm dev` is not this app's to stop. The sidecar
  also stops itself when its launcher goes away
  (`AGENTROOM_EXIT_WITH_PARENT` plus the app's `AGENTROOM_PARENT_PID`, set by
  the macOS app and nothing else), which is prevention rather than a bound: it
  ends the app's own child, on the authority of having launched it. The backend
  arms that check before asynchronous startup and compares once immediately, so
  an app that dies before Node reaches the watchdog is still detected.
- Backend sidecar crash restarts are capped.
- Backend compatibility has one local authority and one public advisory source.
  `GET /health.release` contains only public product/API versions and client
  floors; visionOS retains that exact response, blocks known-incompatible pairs
  before authenticated reads or the event socket, and treats missing or invalid
  metadata as unverified rather than as proof of compatibility. The optional
  **Get AgentRoom for Mac** lookup goes directly to the public GitHub Releases
  API with no token, sends no backend address or bearer token, caches only
  public release metadata in device-local defaults for 24 hours, and uses ETag
  revalidation. A DMG is offered only after a version-1 manifest agrees with
  the stable release tag and an exact `arm64` asset in the same release. A
  GitHub failure can fall back to that previously validated advisory cache, but
  the client labels it as a failed refresh and keeps the stable releases link
  visible. It can never change the connected-backend decision or install
  anything.
- Stopping an active turn records only that turn as cancelled. Restorable
  runners return to idle for a follow-up steering turn; stopping DeepSeek kills
  its non-restorable runtime and requires a new AgentRoom session.

Future hardening before broader autonomous execution:

- Stronger process sandboxing and filesystem boundaries.
- Per-workspace and per-runner secret isolation.
- Structured runner protocol instead of stdout/stderr process bridging.
- More explicit pause semantics.
