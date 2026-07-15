## Why

Two verified incidents show the product can walk a user into dead ends no command can fix. First, infra commands assume an ordering the user never promised: `inflexa up` compose-mounts the proxy config without ensuring it exists, so a run against a cleared data dir lets the container engine manufacture `cliproxy/config.yaml` as an empty **directory** — after which `inflexa setup` crashes forever with a raw `EISDIR` ("Setup failed unexpectedly"). Second, setup offers choices it cannot deliver: the compiled binary presents the "Local" embedding mode, downloads the 36 MB model, then verification is *guaranteed* to fail (`Cannot find package 'node-llama-cpp' from '/$bunfs/root/src/index.js'`) because the native runtime is deliberately not bundled (`scripts/build.ts` marks it external) — and the `bun pm trust` step additionally assumes a dev repo (spawns the `bun` CLI against the user's cwd). A non-technical user who just installed the binary is permanently wedged either way. The system must tolerate commands in any order, on any on-disk state, and must never offer an option that cannot succeed in the current install context.

## What Changes

- Introduce a cross-cutting resilience contract for all infra/provisioning commands: every command validates and provisions its own preconditions (no reliance on `setup` having run first), re-running any command from any partial state converges, and no command sequence can produce a state that another command cannot recover from.
- Ensure every compose bind-mount source exists **with the correct type** (file vs directory) before any `compose up`, at one shared seam — the engine must never manufacture host state.
- Heal safely-healable damage: an empty wrong-type filesystem entry where a provisioned file belongs (the mount-manufactured directory) is removed and re-provisioned; **non-empty** unexpected state is never destroyed — it produces an actionable error naming the exact path and the exact next command.
- Translate expected, diagnosable failures before the "failed unexpectedly" backstop: raw errno text (`EISDIR`, `EACCES`, …) reaching the user from a known-cause state is a defect. Every expected failure names its remediation.
- Make `inflexa up` honor its existing spec claim of being "the user-initiated equivalent of the self-healing launch-time gate": it provisions the proxy config (cliproxy mode) before composing, exactly as the launch gate does.
- Offer only achievable choices: the compiled binary stops offering the "Local" embedding mode it cannot run — the picker explains why it is unavailable, `--embeddings local` fails with a named alternative before any download, and hot-path/provider errors direct compiled-binary users to `api-key`/`off` instead of a setup command that cannot succeed. The `bun pm trust` native-runtime step runs only in the from-source context and against the package root, never the user's cwd.

## Capabilities

### New Capabilities

- `infra-state-resilience`: the order-independence and self-healing contract for locally provisioned infra state — precondition self-provisioning, mount-source integrity before compose, safe-heal vs never-destroy rules for damaged state, error translation with named remediation, and idempotent convergence from any partial state.

### Modified Capabilities

- `postgres-provisioning`: the `inflexa up` requirement is strengthened — "equivalent of the self-healing launch-time gate" now explicitly includes provisioning the proxy config (cliproxy mode) and the mount-source integrity check before `compose up`; the launch-time gate requirement gains the same mount-source integrity precondition.
- `local-embeddings`: local mode becomes install-context-aware — unavailable (with an explanation and alternatives) in the compiled binary, where the native runtime cannot resolve; the model download is gated on the runtime being resolvable; the `bun pm trust` step is scoped to the from-source context and the package root; provider and readiness-gate errors carry context-appropriate remediation.

## Impact

- `src/modules/infra/setup.ts` — `writeProxyConfig` heals an empty directory at the config path; setup's outer catch translates diagnosable filesystem states instead of printing the raw error.
- `src/modules/infra/lifecycle.ts` — `up` provisions the proxy config (mode-aware) before compose.
- `src/modules/infra/compose.ts` — the shared seam that knows the mount plan ensures every bind-mount source exists with the right type before `compose up` (one implementation, not copy-pasted guards).
- `scripts/build.ts` — bakes a compiled-context define; `src/lib/` gains the single accessor for it.
- `src/modules/embedding/setup.ts` + `local-provider.ts` — mode offering, download gating, trust-step scoping, and remediation messages become install-context-aware.
- Tests for the damaged-state matrix (missing file, empty wrong-type dir, non-empty dir), `up`-before-`setup` ordering, and the compiled-context embedding behavior.
- No new dependencies; cli subsystem only.
