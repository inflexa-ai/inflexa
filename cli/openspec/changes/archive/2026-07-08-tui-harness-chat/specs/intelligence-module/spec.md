# intelligence-module — Delta

## MODIFIED Requirements

### Requirement: Presentation and CLI import the engine from intelligence

The TUI SHALL NOT import the proxy chat engine: `src/tui/` contains no import of `chat` from
`src/modules/intelligence/chat.ts` (the TUI conversation drives the shared harness turn engine
instead — see `tui-harness-chat`). The engine and its SQLite persistence remain in place as a legacy
surface (its boot-consumed helpers `readApiKey`/`resolveModelId` keep their current importers), and
`src/cli/index.ts` SHALL keep lazy-importing `listSessions` from
`src/modules/intelligence/sessions.ts`. The engine's retirement/relocation is the follow-up
demotion change, not this one.

#### Scenario: The TUI does not reach the proxy engine

- **WHEN** `src/tui/` is searched for imports of the intelligence chat engine
- **THEN** no file imports `chat` from `modules/intelligence/chat.ts`

#### Scenario: Sessions command unchanged

- **WHEN** the `sessions` CLI command action runs
- **THEN** it loads `listSessions` from `src/modules/intelligence/sessions.ts` and lists saved sessions unchanged
