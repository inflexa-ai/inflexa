## ADDED Requirements

### Requirement: The live activity phrase uses the detail of the event

The live-activity phrase of a sandbox or data-profile tool call MUST come from the `detail` of the loop event of the call. The loop computes that detail with the hook of the tool, at the emit site. A surface MUST NOT keep its own tool-name table, and it MUST NOT read the input of a call. The loop event carries no raw input.

Every tool that a name table described before keeps a description, because the hook of each tool describes its own call.

The phrase MUST lead with the tool name, and it MUST append the detail after it when the event has one. This surface renders the phrase on its own, with no tool name beside it. A chat chip prints the name itself and can carry a bare detail. A detail alone would report a `write_file` and an `edit_file` of one path identically, because both describe a call by its path.

The phrase MUST NOT hold a verb that the surface adds. It is carried on a part that already states the step phase, so a leading verb would only restate it.

#### Scenario: A sandbox activity line uses the tool's own hook

- **GIVEN** a sandbox agent tool that declares a `describeCall`
- **WHEN** the workflow reports live activity for a call to it
- **THEN** the reported phrase is the tool's name followed by the detail of the event

#### Scenario: A write and an edit of one path stay distinguishable

- **GIVEN** `write_file` and `edit_file`, which both describe a call by its path
- **WHEN** the workflow reports live activity for a call to each against the same path
- **THEN** the two reported phrases differ

#### Scenario: A refused call keeps its description

- **GIVEN** a call of a tool with a hook, which the call policy refuses
- **WHEN** the workflow reports live activity for the call
- **THEN** the reported phrase holds the tool name and the detail of the call

#### Scenario: A hookless tool still reports a sensible label

- **GIVEN** a sandbox agent tool with no hook
- **WHEN** the workflow reports live activity for it
- **THEN** the reported phrase is the tool name alone

## MODIFIED Requirements

### Requirement: The emit site normalizes every detail

Normalization MUST happen once, at the emit site, and it MUST NOT be delegated to tool authors. The loop MUST remove control characters, remove the text forms of "The emit site removes the listed secret forms from a value" in `tool-call-values`, collapse the detail to a single line, apply the harness secret redaction, and cap the result at 120 code points. The text forms run before the collapse, thus a form that ends at the end of a line ends there.

The unit MUST be the code point, not the UTF-16 unit and not the display column. A cut at a fixed UTF-16 index can split a surrogate pair and emit a lone surrogate. A column count would claim knowledge of the font metrics of the renderer. The harness does not have that knowledge. A host measures columns, because only a host knows the width of its own line.

When the cap actually shortens a detail, the emitted string MUST carry a truncation mark, and the marked result MUST still fall within the 120-code-point bound. A detail that fits MUST be emitted unmarked. A reader MUST therefore be able to tell a shortened detail from a complete one, which matters because a hook returning free-form prose reaches the cap on ordinary input while a hook returning a path or an identifier never does.

A tool author is therefore free to return whatever reads best. A leak or a runaway string is one auditable line's responsibility, not thirty authors'.

The bound and the emit-site transform MUST be reachable from the package barrel (`DETAIL_MAX_LENGTH`, `normalizeDetail`). An embedder contributes its own tool through the host-tools seam, thus its hook pre-empts the same cap the loop enforces. It MUST read the one number, and not a copy that drifts when the harness retunes the cap.

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

#### Scenario: A command flag in a detail is redacted

- **GIVEN** a `describeCall` that returns `db --password hunter2 API_KEY=abc123`
- **WHEN** the loop normalizes it
- **THEN** the emitted detail holds no `hunter2` and no `abc123`

## REMOVED Requirements

### Requirement: A shared resolver derives the detail from a tool name and an input

**Reason**: Its callers were the live activity surfaces, which read the raw input of the loop event. The loop event carries no raw input now, and the event already carries the detail that the same hook computed.

**Migration**: Read the `detail` of the loop event, as "The live activity phrase uses the detail of the event" says.

### Requirement: One resolver serves every call-description surface

**Reason**: The resolver goes. The live activity phrase reads the detail of the event, which the hook of the tool computed at the emit site.

**Migration**: "The live activity phrase uses the detail of the event" holds the rules of the phrase.
