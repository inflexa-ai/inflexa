# Design — workspace-root resolution seam

## Context

Every filesystem consumer in the harness derives an analysis's on-disk location as `join(sessionsBasePath, resourceId, …)`, where `sessionsBasePath` is a construction-time string closed over at DBOS workflow registration (`data-profile.ts`, `create-sandbox.ts`, `mutator.ts`, `post-step-pipeline.ts`, `synthesize-run.ts`, `iterate-report.ts`, `workspace/filesystem.ts`, `docker-client.ts`). Registration happens once per process, so the base is one value for all resources — the constraint recorded as decision D2 of the CLI's archived `embed-harness-runtime` change. The CLI now needs each analysis's tree to live beside the user's data (under its anchor folder), which is a *per-resource* location. Per-resource **values** are impossible under DBOS registration; per-resource **behavior** is not.

## Goals / Non-Goals

**Goals:**
- One seam through which every host-side workspace path is derived: `resolveWorkspaceRoot(resourceId)`.
- The embedder owns *where* a workspace lives; the harness keeps owning the layout *inside* it (`data/`, `runs/{runId}/{stepId}/…`, `reports/`, `previews/`).
- Container-side invariance: sandboxes keep mounting the tree at `/{resourceId}`; the sandbox protocol, Go server, prompts, and provenance watch dirs are untouched.

**Non-Goals:**
- Postgres/DBOS storage layout (out of scope — files only).
- Migration of existing trees (no deployed embedders; the old layout is deleted).
- Any change to what is written or when — only *where*.

## Decisions

### D1. A resolver function, not a base string (and not a value in workflow input)

`resolveWorkspaceRoot: (resourceId: string) => string` becomes the construction-time dep everywhere `sessionsBasePath` was. Registered once (DBOS-safe); returns a different root per resource.

- *Alternative — keep a global base*: rejected; it is the defect (embedders cannot vary location per resource).
- *Alternative — resolve at launch and carry the root in DBOS workflow input*: rejected. It bakes an absolute path into durable state (stale after a folder move between processes, where re-resolution would heal), and it does not cover the non-workflow surfaces that need the same derivation (chat-time workspace reads, report iteration, preview serving) — a resolver must exist for those anyway, so the seam is the single mechanism.

The contract is **synchronous and total for valid resources**: embedder realizations resolve from local state (a DB row, a config map) and throw/reject only for unknown resource ids. It must be **injective** — two live resources must never resolve to the same root (the harness treats the root as exclusively owned). It must be **stable while a resource has an active run**: the harness derives paths at many moments during a run (mount creation, post-step writes, synthesis) and records derived paths in DBOS step outputs, so a mid-run change would split the tree and diverge replay. Enforcing that stability is the embedder's job (the CLI pairs it with its per-analysis lock; moving/renaming mid-run is unsupported).

### D2. Resolution failures must cross DBOS as throws

Inside workflow/step bodies a failed resolution (unknown resource, unreadable root) must **throw** (via the sanctioned `unwrapOrThrow` bridge where the realization returns a Result), never return an err value across `DBOS.runStep` — DBOS records a step failure only on throw; a returned err would be durably cached as success. This follows the existing house rules in `lib/result.ts`.

### D3. The `{resourceId}` host path segment folds into the root

Today's host path is `{base}/{resourceId}/…`; the resolved root already identifies the resource, so host paths become `{workspaceRoot}/…` with no id segment. Consequences:

- `workspace/paths.ts` helpers (`analysisDataDir`, `runDir`, `runStepDir`, `reportDir`) stop prefixing `{resourceId}/` — they return tree-relative paths joined onto the resolved root.
- `toSandboxPath` can no longer strip a shared base: the container path is `"/" + resourceId + "/" + relative(workspaceRoot, hostPath)` (and its inverse resolves container paths by stripping `/{resourceId}/` then joining onto the root). The container view is unchanged.
- Docker bind mounts become `${workspaceRoot}:/{resourceId}:ro` + `${workspaceRoot}/runs/{runId}/{stepId}:/{resourceId}/runs/{runId}/{stepId}:rw` (`docker-client.ts`, `mount-plan.ts` unchanged on the container side). K8s `buildPodMounts` keeps PVC+subPath semantics with subPaths computed relative to the PVC root the resolver's results live under.

### D4. Previews move inside the tree; the URL claim formula does not

Preview storage becomes `{workspaceRoot}/previews/{previewId}/v{N}` (+ shared `assets/`, `preview-meta.json`), replacing the top-level `previews/{analysisId}/{previewId}/v{N}` tree. The original out-of-tree placement existed so an HTTP content server could treat `previews/{analysisId}` as an authorization boundary — that boundary is a *URL-space* concept: `previewResourceId(analysisId, previewId) = previews/{analysisId}/{previewId}` remains the token `res` claim exactly as-is (`contracts/content-url.ts`, drift-tested against the Go mirror). A host that serves previews maps the URL claim to storage through its own resolver realization; the OSS default (`UnavailablePreviewPublisher`) serves nothing, so nothing breaks locally.

- *Alternative — keep previews out-of-tree*: rejected; previews are user-generated analysis content, and "everything an analysis generates lives in its tree" is the point of the paired CLI change.

### D5. Naming: "workspace", not "session"

The seam, types, and spec language say **workspace root** (`resolveWorkspaceRoot`, `WorkspaceRootResolver` if a named type is warranted). "Session tree" dies with `sessionsBasePath` — it collided with chat sessions, an unrelated concept.

## Risks / Trade-offs

- [Embedder resolves two resources to one root] → the injectivity requirement is stated in the seam's spec; the harness does not verify it (cost/benefit: verification would require global knowledge the harness deliberately lacks).
- [Root changes mid-run (folder moved/renamed)] → declared unsupported by the seam contract; the CLI enforces via its per-analysis lock. A container's bind mount pins the old path regardless, so no harness-side mitigation is possible even in principle.
- [Resolver failure surfaces as durable success] → D2: throw-based bridging inside DBOS bodies, per `lib/result.ts` house rules.
- [Managed content server reads previews from the old path] → coordination note for the managed deployment: URL space unchanged, filesystem mapping moves with its resolver realization. OSS unaffected.
- [Recovered workflow on a machine where resolution differs] → this is a *feature* (heals moves between processes) but requires realizations to resolve from durable local state, not process memory — stated in the seam contract.

## Migration Plan

None — no deployed embedders, no data migration. Delete `sessionsBasePath` from all dep types in one change; the compiler enumerates every consumer. The paired CLI change (`cli/openspec/changes/unify-analysis-workspace`) supplies the CLI realization; landing order is harness first (the CLI consumes the new package surface).

## Open Questions

None blocking. The `previewsForAnalysis` helper (authorization-boundary listing) reduces to `{workspaceRoot}/previews` and may fold away entirely — implementer's call at the call sites.
