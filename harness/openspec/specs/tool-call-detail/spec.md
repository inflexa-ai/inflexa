# tool-call-detail Specification

## Purpose

Give one line that names what a tool call is doing, so a host renders a call as
more than a bare tool name. A tool declares the line beside its own
`inputSchema`, because only the author of a tool knows which field identifies a
call. The loop normalizes each line once, at the emit site. Thus a leak or a
runaway string is the responsibility of one auditable place, and not of thirty
tool authors.

## Requirements

### Requirement: A tool describes its own call through an optional hook

A tool definition SHALL require a `describeCall` decision: either a `(input) => string` hook, or the literal `"none"`. The hook SHALL be colocated with the Zod `inputSchema` and typed against `z.infer<Schema>`, SHALL be synchronous, and SHALL be a pure function of its input — it performs no I/O and reads no ambient state.

`"none"` SHALL be an authoring-time value only. A tool that declares it SHALL package no hook, and SHALL be observable exactly as a tool with no hook is. Declining remains a normal state; omitting the decision does not.

The packaged `Tool` SHALL continue to expose `describeCall` as an optional function. The sentinel SHALL be consumed at construction and SHALL NOT reach any consumer, so a reader of a packaged tool distinguishes only "has a hook" from "has none".

A tool whose input cannot distinguish its calls — one whose schema admits a single shape — SHALL declare `"none"` rather than a hook that restates the tool's name.

#### Scenario: A hook is typechecked against the tool's own input type

- **GIVEN** a tool whose `inputSchema` declares a field the hook does not name
- **WHEN** the hook reads a field absent from that schema
- **THEN** the package fails to typecheck

#### Scenario: A tool omitting the decision fails to compile

- **GIVEN** a tool definition that declares neither a hook nor `"none"`
- **WHEN** the package is typechecked
- **THEN** compilation fails at that definition

#### Scenario: A declined tool is indistinguishable from a hookless one at runtime

- **GIVEN** a tool that declares `describeCall: "none"`
- **WHEN** the loop dispatches it
- **THEN** its tool-call events carry no detail, every other field is unchanged, and the packaged tool exposes no `describeCall` property

### Requirement: A tool describes its result through an optional hook
A tool definition MUST accept an optional `describeResult` hook beside `describeCall`. The hook takes the parsed input and the ok-channel result, and it gives a string. It MUST be synchronous and pure, and it MUST never fail a call: a hook that throws or gives an unusable value yields no result detail. The finished event carries the recomputed detail when the hook gives one, and the started detail otherwise. The hook runs only on an ok outcome. The emit site normalizes a result detail exactly as it normalizes a call detail: one line, redaction, and the length cap.

#### Scenario: The finished event carries the result detail
- **WHEN** a tool with a result hook resolves ok
- **THEN** the finished event carries the hook's normalized text, and the started event keeps its own detail

#### Scenario: An error keeps the started detail
- **WHEN** a tool with a result hook resolves with an error outcome
- **THEN** the finished event carries the started detail, and the hook does not run

#### Scenario: A throwing result hook costs nothing
- **WHEN** a result hook throws
- **THEN** the call outcome is unchanged, and the finished event carries the started detail

#### Scenario: A result detail is normalized
- **WHEN** a result hook gives a multi-line text over the cap
- **THEN** the finished event carries one capped line

### Requirement: The emit site normalizes every detail

Normalization SHALL happen once, at the emit site, and SHALL NOT be delegated to tool authors. The loop SHALL collapse the detail to a single line, remove control characters, apply the harness secret redaction, and cap the result at 120 code points.

The unit SHALL be the code point, not the UTF-16 unit and not the display column. A cut at a fixed UTF-16 index can split a surrogate pair and emit a lone surrogate. A column count would claim knowledge of the font metrics of the renderer. The harness does not have that knowledge. A host measures columns, because only a host knows the width of its own line.

When the cap actually shortens a detail, the emitted string SHALL carry a truncation mark, and the marked result SHALL still fall within the 120-code-point bound. A detail that fits SHALL be emitted unmarked. A reader SHALL therefore be able to tell a shortened detail from a complete one, which matters because a hook returning free-form prose reaches the cap on ordinary input while a hook returning a path or an identifier never does.

A tool author is therefore free to return whatever reads best. A leak or a runaway string is one auditable line's responsibility, not thirty authors'.

The bound and the emit-site transform SHALL be reachable from the package barrel (`DETAIL_MAX_LENGTH`, `normalizeDetail`). An embedder contributes its own tool through the host-tools seam, thus its hook pre-empts the same cap the loop enforces. It SHALL read the one number, and not a copy that drifts when the harness retunes the cap.

#### Scenario: A multi-line detail becomes one line

- **GIVEN** a `describeCall` that returns a string containing newlines
- **WHEN** the loop normalizes it
- **THEN** the emitted detail is a single line

#### Scenario: An over-long detail is capped and marked

- **GIVEN** a `describeCall` that returns 5000 characters
- **WHEN** the loop normalizes it
- **THEN** the emitted detail is at most 120 code points and ends with a truncation mark

#### Scenario: A detail within the cap carries no mark

- **GIVEN** a `describeCall` that returns a string shorter than the cap
- **WHEN** the loop normalizes it
- **THEN** the emitted detail is the string unchanged, with no truncation mark appended

#### Scenario: A cut landing on whitespace does not strand it before the mark

- **GIVEN** a `describeCall` whose returned string has a space at the cut position
- **WHEN** the loop caps it
- **THEN** the trailing whitespace is removed before the mark is appended

#### Scenario: A secret in a detail is redacted

- **GIVEN** a `describeCall` whose returned string contains a value the harness secret redaction matches
- **WHEN** the loop normalizes it
- **THEN** the emitted detail carries the redacted form, and no tool code performed the redaction

### Requirement: A hook describes the call the tool will actually make

A hook SHALL derive its detail from the same fields, in the same precedence, that the tool's `execute` uses to decide what the call does. Where a schema admits several fields that could name a call, the hook SHALL follow the tool's own resolution order rather than the order the fields are declared in.

A hook SHALL account for a field the tool defaults internally, supplying the same default, so that the ordinary call — the one that omits every optional field — still produces a detail.

A detail that names something other than what the call did is worse than no detail: it is a false statement a host renders with the same authority as a true one. The hook is synchronous and sees only the parsed input, so it cannot observe what `execute` computes; agreement is therefore a property the hook's author establishes and a test pins, not one the type system can check.

#### Scenario: A hook follows the tool's precedence, not the schema's field order

- **GIVEN** a tool whose `execute` resolves one field in preference to another, and a call supplying both
- **WHEN** the hook describes that call
- **THEN** the detail names the field `execute` resolved, not the other

#### Scenario: A filtering field does not displace the field naming the target

- **GIVEN** a tool whose schema carries both a field selecting what to act on and a field narrowing the result, and a call supplying both
- **WHEN** the hook describes that call
- **THEN** the detail names what was acted on

#### Scenario: A call omitting every optional field still produces a detail

- **GIVEN** a tool whose fields are all optional and whose `execute` supplies defaults for them
- **WHEN** a call supplies none of them
- **THEN** the hook produces a detail describing the defaulted call rather than an empty string

#### Scenario: A hook's exact output is pinned per tool

- **GIVEN** a tool that ships a hook
- **WHEN** the test suite runs
- **THEN** at least one assertion covers the exact string that hook produces for a representative call

### Requirement: A hook marks a field that narrows, and joins two facts with words

A required field is the subject of the call, because the tool cannot run without it. A hook SHALL name the value of that field directly.

An optional field that narrows a result is a filter. The tool returns that result with the field or without it. A hook SHALL mark such a field. An unmarked value reads as the thing the call acted on, and that statement is false.

A free-form text needle SHALL ride behind `matching "<needle>"`. An enumerated restriction SHALL ride as a qualifier in parentheses at the end, or as a noun phrase when it names the whole call.

A hook SHALL bound a free-form needle at 32 code points. A hook SHALL also bound each part of a detail that carries two parts. The emit-site cap cuts the tail. Thus a hook that leaves the bound to the emit site loses the mark that closes the needle. It also loses a filter behind a target that runs long.

A detail SHALL carry nothing from the visual vocabulary of a host. A host owns its separators, its glyphs, and the width of its own line. A hook that states two facts SHALL join them with a word.

#### Scenario: A bare needle does not read as a target

- **GIVEN** a tool whose optional needle filters a store it browses, and a call that supplies the needle alone
- **WHEN** the hook describes that call
- **THEN** the detail marks the needle, and it does not render the needle bare

#### Scenario: A long needle keeps the mark that closes it

- **GIVEN** a call whose needle is longer than the needle bound
- **WHEN** the hook describes that call
- **THEN** the needle carries a truncation mark inside the marked form, and the marked form is closed

#### Scenario: A long target does not swallow the filter

- **GIVEN** a call that supplies a needle and a target longer than the cap
- **WHEN** the hook describes that call
- **THEN** the detail names both parts within the cap, and the emit site shortens nothing

#### Scenario: A detail joins two facts without a host separator

- **GIVEN** a hook that states a target and a filter in one detail
- **WHEN** the hook describes that call
- **THEN** the two parts join with a word, and the detail carries no separator glyph

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
