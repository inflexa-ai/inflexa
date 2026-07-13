# conversation-briefings Specification (delta)

## ADDED Requirements

### Requirement: Briefing definitions are declarative, typed, and pure

A briefing SHALL be defined by a `BriefingDefinition<TInput>` value carrying `name` (registry key), `description` (one line stating what the agent is being made aware of), `mode` (`"standing"` or `"rolling"`), and `render(input) → { content, caption }`. `render` SHALL be pure — no I/O, no clock, no ambient state — so a definition is renderable and testable in isolation. Definitions SHALL live one per file under `src/prompts/briefings/`, each with a colocated input fixture, and each definition SHALL have a snapshot test rendering its fixture.

#### Scenario: A definition renders in isolation from its fixture

- **WHEN** a briefing definition's `render` is called with its colocated fixture
- **THEN** it returns the full wire `content` and a one-line `caption` without touching I/O, and the output matches the snapshot

#### Scenario: Render is deterministic

- **WHEN** `render` is called twice with the same input
- **THEN** both calls return identical `content` and `caption`

### Requirement: Briefing mode determines placement, refresh, and persistence

A standing briefing SHALL be injected exactly once at conversation start, SHALL be immutable for the thread's lifetime, SHALL be persisted, and SHALL ride the cacheable prefix ahead of all turns. A rolling briefing SHALL be re-rendered on every turn, injected at the tail of the assembled message array, and SHALL NOT be persisted. No other placement/refresh combination SHALL be representable.

#### Scenario: A standing briefing is injected once

- **GIVEN** a thread whose standing briefings were injected at conversation start
- **WHEN** subsequent turns run
- **THEN** the briefing content is not re-rendered or re-injected; the persisted prefix is reused as-is

#### Scenario: A rolling briefing re-renders each turn and leaves no rows

- **GIVEN** an agent loop composed with a rolling briefing
- **WHEN** two consecutive turns run and the thread is read back from storage
- **THEN** each turn's assembled tail contained a freshly rendered block, and no rolling-briefing row exists in thread history

### Requirement: Composition is caller-owned, ordered, and omits unavailable inputs

The set of briefings an agent loop receives SHALL be composed explicitly at the call site (chat-turn preparation for the main conversation; the invoking tool for sub-agent loops) — there SHALL be no auto-discovery. Briefings SHALL be injected in the caller's array order, and that order SHALL be stable across the turns of a thread. When a briefing's input is unavailable (e.g. the data profile is still running or failed), the briefing SHALL be omitted entirely — never rendered as a placeholder.

#### Scenario: Injection preserves composition order

- **GIVEN** a caller composing briefings `[a, b]`
- **WHEN** they are injected at conversation start
- **THEN** `a` precedes `b` in the persisted prefix and on the wire

#### Scenario: An unavailable input omits the briefing

- **GIVEN** a data profile that has not completed when a thread's first turn is prepared
- **WHEN** standing briefings are composed
- **THEN** no data-profile briefing is injected, and no placeholder ("profile pending") content is rendered

### Requirement: Each briefing is one uniformly wrapped user message

Each briefing SHALL be injected as its own `user` message. The injection path — not the definition — SHALL wrap the rendered `content` in a uniform `<briefing name="...">…</briefing>` envelope, so definitions carry plain content and the wire convention lives in one place. The conversation agent's system prompt SHALL state, in one sentence, that `<briefing>` blocks are trusted context supplied by the platform.

#### Scenario: The harness wraps rendered content

- **GIVEN** a briefing definition whose `render` returns plain content
- **WHEN** the briefing is injected
- **THEN** the wire message is a `user` message whose text is the content wrapped in `<briefing name="<definition name>">…</briefing>`

### Requirement: Standing briefings are never superseded

A standing briefing SHALL NOT be updated, replaced, or re-rendered within its thread, even when its source data changes. Updates to source data SHALL reach the conversation as regular messages (e.g. the data-profile re-run announcement); new threads and new sub-agent loops pick up fresh data at their own start.

#### Scenario: A mid-thread data-profile re-run leaves the briefing untouched

- **GIVEN** a thread whose prefix contains a data-profile standing briefing
- **WHEN** the data profile re-runs and produces a new summary
- **THEN** the persisted briefing rows are unchanged and the new profile information arrives only as a regular message

### Requirement: Standing briefing injection surfaces briefing-card parts to the host

When standing briefings are injected, the harness SHALL surface one typed briefing-card part per briefing carrying its `name` and `caption` — returned from turn preparation to the caller, since turn preparation owns no transport — on the same typed-part contract hosts already consume (as with plan-card / run-card). The host emits the surfaced parts onto its stream. Rolling briefings SHALL NOT surface parts.

#### Scenario: A standing briefing announces itself

- **WHEN** a data-profile standing briefing is injected at conversation start
- **THEN** turn preparation returns a briefing-card part with the briefing's name and caption for the host to emit and render

#### Scenario: Rolling briefings are silent

- **WHEN** a turn is assembled with a rolling briefing
- **THEN** no briefing-card part is surfaced

### Requirement: The data profile is a standing briefing of the main conversation

The main conversation SHALL compose a data-profile standing briefing at conversation start when the analysis's data profile is complete. Its `caption` SHALL summarize the profile at a glance: file count, the data kinds at the best granularity the persisted profile carries (distinct file formats today — per-file assay/domain kinds are not persisted), and the profile timestamp. Sub-agent loops MAY compose the same definition as an unpersisted initial message.

#### Scenario: A completed profile briefs the first turn

- **GIVEN** an analysis whose data profile completed before the thread's first turn
- **WHEN** the first turn is prepared
- **THEN** the assembled messages begin with the data-profile briefing and a briefing-card part is surfaced with a caption naming file count, data kinds, and profile timestamp
