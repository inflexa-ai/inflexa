## ADDED Requirements

### Requirement: A tool describes its own call through an optional hook

A tool definition SHALL accept an optional `describeCall(input) => string` hook, colocated with the Zod `inputSchema` and typed against `z.infer<Schema>`. The hook SHALL be synchronous, and it SHALL be a pure function of its input — it performs no I/O and reads no ambient state.

A tool that declares no hook SHALL be observable exactly as it is without one. Coverage grows tool by tool; absence is a normal state, never an error.

#### Scenario: A hook is typechecked against the tool's own input type

- **GIVEN** a tool whose `inputSchema` declares a field the hook does not name
- **WHEN** the hook reads a field absent from that schema
- **THEN** the package fails to typecheck

#### Scenario: A tool without a hook is unaffected

- **GIVEN** a tool that declares no `describeCall`
- **WHEN** the loop dispatches it
- **THEN** its tool-call events carry no detail, and every other field is unchanged

### Requirement: The detail is computed best-effort and never fails a call

The loop SHALL compute the detail at dispatch, inside a guard. A hook that throws, that returns a value which is not a string, or that returns an empty string SHALL yield no detail. The loop SHALL then dispatch the tool unchanged and SHALL record the hook failure through the injected `Logger` at `debug`.

The loop SHALL validate the call's input against the tool's `inputSchema` before it calls the hook, and SHALL call the hook only when validation succeeds. A tool-call event is emitted before the loop's dispatch-time validation, so the raw value at the emit site is unvalidated model output; without this parse the hook's declared input type would not hold.

The guard SHALL enclose that validation as well as the hook. Schema validation reports a rejected value as a result, but it raises for a schema it cannot run synchronously — one carrying an asynchronous refinement, or a refinement whose own predicate raises. A tool list is open, because an embedder contributes tools through the host-tools seam, so such a schema is reachable and its failure SHALL be absorbed like any other.

#### Scenario: A throwing hook does not break the call

- **GIVEN** a tool whose `describeCall` throws
- **WHEN** the loop dispatches that call
- **THEN** the tool executes normally, its events carry no detail, and the turn is unaffected

#### Scenario: A schema that throws during validation does not break the call

- **GIVEN** a tool that declares a hook and whose `inputSchema` raises when it validates
- **WHEN** the loop computes the detail for a call to it
- **THEN** the tool executes normally, its events carry no detail, and the turn is unaffected

#### Scenario: An input that fails validation produces no detail

- **GIVEN** a tool call whose input does not satisfy the tool's `inputSchema`
- **WHEN** the loop reaches the emit site
- **THEN** the hook is not called and the event carries no detail

#### Scenario: A hook returning a non-string is ignored

- **GIVEN** a `describeCall` that returns `undefined` or an empty string
- **WHEN** the loop computes the detail
- **THEN** the event carries no detail rather than an empty one

### Requirement: The emit site normalizes every detail

Normalization SHALL happen once, at the emit site, and SHALL NOT be delegated to tool authors. The loop SHALL collapse the detail to a single line, remove control characters, apply the harness secret redaction, and cap the result at 120 characters.

A tool author is therefore free to return whatever reads best. A leak or a runaway string is one auditable line's responsibility, not thirty authors'.

#### Scenario: A multi-line detail becomes one line

- **GIVEN** a `describeCall` that returns a string containing newlines
- **WHEN** the loop normalizes it
- **THEN** the emitted detail is a single line

#### Scenario: An over-long detail is capped

- **GIVEN** a `describeCall` that returns 5000 characters
- **WHEN** the loop normalizes it
- **THEN** the emitted detail is at most 120 characters

#### Scenario: A secret in a detail is redacted

- **GIVEN** a `describeCall` whose returned string contains a value the harness secret redaction matches
- **WHEN** the loop normalizes it
- **THEN** the emitted detail carries the redacted form, and no tool code performed the redaction

### Requirement: Tool call events carry the detail

`tool-started` and `tool-finished` SHALL carry `detail?: string`, and the wire tool-call part SHALL carry the same optional field. The field SHALL be absent — not empty — when no detail was produced.

A host SHALL be able to render a tool call as its name plus its detail with no tool-specific knowledge.

#### Scenario: A described call carries its detail on both events

- **GIVEN** a tool that declares a `describeCall`
- **WHEN** the loop dispatches it and the call resolves
- **THEN** both the started and the finished event carry the same normalized detail

#### Scenario: An undescribed call omits the field

- **GIVEN** a tool that declares no hook
- **WHEN** its events are emitted
- **THEN** `detail` is absent from both, rather than present and empty

### Requirement: A host treats the detail as opaque text

The detail SHALL be a display string with no internal structure a consumer may parse. A host SHALL render it and SHALL NOT split, key on, or otherwise interpret its contents.

The contract is harness-owned so it can widen when a renderer needs structure. A host that parses the string recreates the schema coupling this capability exists to remove.

#### Scenario: The detail is rendered, not interpreted

- **GIVEN** a detail string containing a separator character
- **WHEN** a host renders the tool call
- **THEN** it displays the string as received and derives no fields from it

### Requirement: A shared resolver derives the detail from a tool name and an input

The harness SHALL provide a resolver constructed over a supplied `readonly Tool[]`, mapping a tool name plus an input to a detail, so every surface that must describe a call from its name and input resolves through one implementation and cannot drift from the live path.

The tool list SHALL be supplied by the caller rather than held inside the harness. An embedder contributes tools through the host-tools seam, and a name map internal to the harness could never see them. Supplying one agent's list also makes a duplicate tool id unrepresentable, because a tool list rejects a duplicate id at registry construction.

The resolver SHALL NOT be a transcript read path, and SHALL NOT be part of the embedder-facing surface. A detail is display data: it is recorded when it is produced and replayed from that record (see the conversation-display-storage capability). Deriving it again at read time would make a transcript depend on the tool's current schema and hook, so a schema change would rewrite what a past turn appears to have done. The resolver's callers are the live activity surfaces and the one-time startup migration of turns stored before display was recorded.

#### Scenario: A live activity surface resolves a described call

- **GIVEN** a call to a tool that declares a hook
- **WHEN** an activity surface describes it through a resolver over that agent's tools
- **THEN** it reports the same detail the live event carried

#### Scenario: An embedder-contributed tool resolves

- **GIVEN** a call to a tool supplied through the host-tools seam
- **WHEN** the resolver is built over the composed agent tool list
- **THEN** the call's detail resolves rather than being dropped

#### Scenario: An unknown tool name resolves to no detail

- **GIVEN** a call naming a tool absent from the supplied list
- **WHEN** the resolver runs
- **THEN** it yields no detail and the call is described by its name alone

### Requirement: One resolver serves every call-description surface

The live-activity phrase a workflow reports for a sandbox or data-profile tool call SHALL resolve through the same hook. A surface SHALL NOT keep its own tool-name table or read tool input fields through an untyped record.

A caller SHALL supply the tool list of the agent whose calls it describes. A tool with no hook SHALL fall back to the tool name alone.

Every tool that the replaced surface described SHALL keep a description. The removed name table read a `path` field from any input generically, so it served tools it never named; a hook roster drawn only from its named entries would make those tools less informative than before the change.

The phrase SHALL lead with the tool name, and SHALL append the detail after it when one resolves. This surface renders the phrase on its own, with no tool name beside it — unlike a chat chip, which prints the name itself and can carry a bare detail. A detail alone would therefore report a `write_file` and an `edit_file` of one path identically, because both describe a call by its path.

No verb SHALL be added to the phrase. It is carried on a part that already states the step phase, so a leading verb would only restate it.

#### Scenario: A sandbox activity line uses the tool's own hook

- **GIVEN** a sandbox agent tool that declares a `describeCall`
- **WHEN** the workflow reports live activity for a call to it
- **THEN** the reported phrase is the tool's name followed by the hook's description, not a phrase from a name-keyed table

#### Scenario: A write and an edit of one path stay distinguishable

- **GIVEN** `write_file` and `edit_file`, which both describe a call by its path
- **WHEN** the workflow reports live activity for a call to each against the same path
- **THEN** the two reported phrases differ

#### Scenario: A tool the removed table served generically keeps its description

- **GIVEN** a workspace tool the removed name table never named, but whose input carries a path it described
- **WHEN** the workflow reports live activity for a call to it
- **THEN** the reported phrase still names what the call acts on, not the tool name alone

#### Scenario: A hookless tool still reports a sensible label

- **GIVEN** a sandbox agent tool with no hook
- **WHEN** the workflow reports live activity for it
- **THEN** the reported phrase is the tool name alone
