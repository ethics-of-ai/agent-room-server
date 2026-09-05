// Standing spatial-diagram contract shared by runner adapters. One stable,
// cache-friendly string:
// Codex receives it composed into each turn prompt by AgentTurnContextAssembler;
// Claude Code receives the same string appended to the SDK session's system
// prompt (runner/claudeCode/settings.ts). Phrased as a capability, not a mandate, so
// the agent does not volunteer diagrams nobody asked for. Updating this string
// alongside a schema bump is the schema-evolution channel — every session is
// current on its next turn, with no stale knowledge to migrate.

export const DIAGRAM_PROMPT_INSTRUCTION = [
  "Spatial solution diagrams: when the user asks for a design or architecture",
  "deliverable, you can author it as an interactive 3D diagram by writing a",
  "`<name>.diagram.json` workspace file (recommended location:",
  "`docs/diagrams/<name>.diagram.json`; commit it like any source file).",
  "Example document:",
  '{"schemaVersion":3,"kind":"solution","name":"Checkout flow","nodes":[{"id":"api-gw","label":"API Gateway","role":"service","group":"edge"},{"id":"orders","label":"Orders Service","description":"Owns order state; the only writer of Orders DB.","role":"service","group":"core"},{"id":"orders-db","label":"Orders DB","role":"datastore","group":"core"},{"id":"payments","label":"Payments (Stripe)","role":"external"}],"edges":[{"id":"e1","from":"api-gw","to":"orders","label":"REST","kind":"sync"},{"id":"e2","from":"orders","to":"orders-db","kind":"read_write"},{"id":"e3","from":"orders","to":"payments","label":"charge","description":"Fire-and-forget; a webhook confirms the charge.","kind":"async"}],"groups":[{"id":"edge","label":"Edge"},{"id":"core","label":"Core services"}],"flows":[{"id":"place-order","label":"Place an order","edges":["e1","e2","e3"]}]}',
  "Node `role` and edge `kind` take only these values — roles: `service`,",
  "`datastore`, `queue`, `cache`, `external`, `actor`, `gateway`, `function`,",
  "`load_balancer`, `cdn`, `auth`, `scheduler`, `blob_storage`, `ml_model`,",
  "`stream`;",
  "edge kinds: `sync`, `async`, `read_write`, `event`, `replicates`. The human",
  "sees each value as a visual treatment, so choose them for their meaning and",
  "you can talk about the diagram in the human's terms: service = blue box,",
  "datastore = green stack of disks, queue = orange horizontal pipe, cache =",
  "low gold cylinder, external = translucent gray box, actor = purple sphere,",
  "gateway = teal rotated cube, function = yellow cone, load_balancer = flat",
  "coral slab, cdn = translucent cyan globe, auth = tall rose pillar,",
  "scheduler = indigo diamond on its point, blob_storage = wide bronze drum,",
  "ml_model = inverted violet cone, stream = long crimson horizontal pipe;",
  "sync = solid light-gray arrow,",
  "async = dashed orange arrow, read_write = green shaft with an arrowhead at",
  "one end and a disc at the other, event = dashed purple arrow, replicates =",
  "solid teal arrow (dashed means message passing, solid a call or data",
  "relationship). Unknown values render as a gray generic shape plus a",
  "warning. Ids match",
  "`^[a-z0-9][a-z0-9_-]{0,63}$` and are unique within their collection;",
  "node ids must not collide with group ids; `from`/`to` and a node's optional",
  "`group` must reference declared ids, edge endpoints must differ, and",
  "`groups` is a flat list. Keep ids stable when editing — renaming an id",
  "orphans the human's spatial adjustments keyed to it.",
  "`flows` is optional and requires `schemaVersion: 2`. A flow is a named path",
  "a request or a message actually takes: its `edges` are existing edge ids in",
  "traversal order, and the renderer lights them one hop at a time so a person",
  "can follow the sequence. Add one per story worth walking through rather than",
  "one per edge. `description` is optional on the document, a node, an edge, and",
  "a group (1–500 chars, requires `schemaVersion: 3`): one or two sentences on",
  "why the component exists or what the edge carries, shown on the human's",
  "selection card — add one where a design decision needs explaining, never to",
  "restate the label. Caps: 64 nodes, 128",
  "edges, 16 groups, 16 flows, 32 steps per flow. The engine lays the diagram",
  "out in 3D: describe semantics",
  "only and never write positions or coordinates. Never create or edit",
  "`*.diagram.human.json` — that file belongs to the human's spatial edits.",
  "The human can also edit the `*.diagram.json` base document directly, so",
  "before editing an existing diagram re-read it rather than assuming the",
  "version you last wrote, and Read its sibling `.human.json`",
  "when present and respect what the human moved, hid, locked, or collapsed by",
  "preserving the affected stable ids and leaving the override file untouched."
].join(" ");
