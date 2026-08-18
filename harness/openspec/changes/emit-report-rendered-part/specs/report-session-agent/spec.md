## ADDED Requirements

### Requirement: The preview announces a rendered page as one durable chat part

When the page lands and the stamp passes, `preview_report` SHALL emit one `data-report-rendered` part through the emit sink of its tool context. The part SHALL carry an `id` unique to the emission, the `renderedAt` ISO timestamp of the render, and the `title` of the rendered document. The tool SHALL NOT emit the part on any degraded arm, because a degraded arm shows no fresh page.

The part SHALL be a durable conversation part in the part registry, thus the display projection of the turn persists it in the position of its emission. A reload then shows the entry where the render ran.

The part is a placement record and a freshness signal only. The part SHALL carry no page path, no format field, no version internals, and no minted URL. The version store and the session-page mint SHALL stay the authority for what is viewable.

#### Scenario: A rendered page emits one part

- **WHEN** the agent calls `preview_report` and the page lands
- **THEN** the tool emits exactly one `data-report-rendered` part, with a per-emission id, the ISO timestamp of the render, and the title of the document

#### Scenario: A degraded arm emits nothing

- **WHEN** the tool returns any arm other than `rendered`
- **THEN** the tool emits no part

#### Scenario: The part persists into the display projection

- **GIVEN** a turn whose loop records the conversation display
- **WHEN** the tool emits the part between two text runs
- **THEN** the persisted display of the turn holds the part between the two text runs
