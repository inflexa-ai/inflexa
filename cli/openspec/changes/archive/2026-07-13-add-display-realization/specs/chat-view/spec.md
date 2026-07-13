# chat-view — delta

## ADDED Requirements

### Requirement: Display-card parts map live and on reload

The conversation store SHALL map `data-presentation`, `data-file-reference`,
and `data-report-preview` / `data-report-preview-failed` events to first-class
parts in both paths — the live emit reducer (`applyEmitEvent`) and the thread
reconstruction path (`cortexToUiMessage`) — through shared readers, so a
reloaded transcript renders the same cards as the live turn (the harness
card-builders guarantee byte-identical card data across both paths).
Text-shaped presentations (`markdown`, `code`, `table`) map to an inline
presentation part; pixel-shaped content (`echart`, `svg` presentations, file
references, report previews) maps to openable card parts carrying only the
semantic reference fields, extracted at receipt (copy-on-receive — no retained
harness objects). Unknown `data-*` parts SHALL keep the existing one-line
tagged-mention fallback.

#### Scenario: Live and reloaded turns render alike

- **GIVEN** a turn where the agent emitted a markdown presentation and a file-reference gallery
- **WHEN** the session is closed and the thread reloads from pg
- **THEN** the reconstructed transcript shows the same inline markdown block and the same openable gallery card as the live turn did

#### Scenario: A failed report preview is visible

- **WHEN** the harness emits `data-report-preview-failed`
- **THEN** the transcript shows a degraded preview card naming the reason, not a `[part:…]` tag

#### Scenario: Unknown parts still surface

- **WHEN** the harness emits a `data-*` part the CLI has no renderer for
- **THEN** the transcript shows the one-line tagged mention (observed, not swallowed)
