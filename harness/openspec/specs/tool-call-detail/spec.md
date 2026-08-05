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

### Requirement: The emit site normalizes every detail

Normalization SHALL happen once, at the emit site, and SHALL NOT be delegated to tool authors. The loop SHALL collapse the detail to a single line, remove control characters, apply the harness secret redaction, and cap the result at 120 code points.

The unit SHALL be the code point, not the UTF-16 unit and not the display column. A cut at a fixed UTF-16 index can split a surrogate pair and emit a lone surrogate. A column count would claim knowledge of the font metrics of the renderer. The harness does not have that knowledge. A host measures columns, because only a host knows the width of its own line.

When the cap actually shortens a detail, the emitted string SHALL carry a truncation mark, and the marked result SHALL still fall within the 120-code-point bound. A detail that fits SHALL be emitted unmarked. A reader SHALL therefore be able to tell a shortened detail from a complete one, which matters because a hook returning free-form prose reaches the cap on ordinary input while a hook returning a path or an identifier never does.

A tool author is therefore free to return whatever reads best. A leak or a runaway string is one auditable line's responsibility, not thirty authors'.

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
