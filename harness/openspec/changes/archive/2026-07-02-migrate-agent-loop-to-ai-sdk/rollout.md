## Operational Rollout Note

Before enabling the AI SDK-backed agent loop/runtime, drain or cancel active DBOS workflows.

Existing DBOS operation outputs are internal execution cache state and are not migrated by this change. Completed Cortex-native analysis outputs remain readable through their ledgers, files, artifacts, vectors, run streams, summaries, synthesis JSON, and reports, but in-flight workflow replay across the runtime/message-shape change is intentionally unsupported.
