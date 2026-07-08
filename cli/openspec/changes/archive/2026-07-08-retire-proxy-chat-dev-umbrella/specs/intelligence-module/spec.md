# intelligence-module — Delta

The module retires: the proxy chat engine is deleted (orphaned since the TUI moved to the harness
conversation agent), the proxy helpers move to `modules/proxy/`, and the `sessions` command moves
to `modules/analysis/` (sessions remain the live launch-identity store; only `messages`/`parts`
freeze as legacy-readable history). The capability ends with zero requirements and its main spec is
deleted at sync.

## REMOVED Requirements

### Requirement: AI interaction is owned by the intelligence module

### Requirement: The intelligence module is headless

### Requirement: Presentation and CLI import the engine from intelligence

### Requirement: Assistant part is broadcast before streaming
