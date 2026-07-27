## REMOVED Requirements

### Requirement: inflexa sessions lists chat sessions

**Reason**: Session identity moves to the harness Postgres thread store, and the command's output was already actionable by nothing — no other command accepts a session id. Keeping it would make it the only headless surface requiring a Postgres connection.
**Migration**: Session listing lives in the TUI's session-switch picker over the harness thread store. The command's registration, its `auto` agent-policy entry (and policy snapshot), its e2e coverage, and its generated reference page are removed with it.
