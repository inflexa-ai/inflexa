# File Materialization: cli → harness (verified 2026-07-02, post-merge tree)

The harness **never copies, downloads, or stages input files** — it assumes the tree is
already on host disk and only (1) registers/profiles a `StagedInput[]` manifest and
(2) bind-mounts the analysis tree into the sandbox. Physical placement is entirely the
embedder's (cli's) job. Same-machine embedding makes this a hardlink/copy, no transport.

## 1. The contract

**Manifest type** — `harness/src/execution/staged-input.ts:22-31`:
`{fileId, mountName, key, fileName, hash, size, relativePath}` where `relativePath` =
`"inputs/{mountName}/{key}"`. Header doc (`:4-9`): the workflows "never download or copy
input data, and never call a staging step. The embedder stages the tree at the async
edge, once, BEFORE invoking the harness."

**Entry point** — `triggerDataProfile(deps, params)` with
`DataProfileTriggerParams {auth, analysisId, stagedInputs}`
(`harness/src/tasks/data-profile.ts:387-391`, `:457`). The manifest rides in
`DataProfileWorkflowInput.stagedInputs` (`:95`).

**Two facts the old doc got wrong:**
- `executeAnalysis` **never receives a manifest** — `ExecuteAnalysisInput`
  (`workflows/execute-analysis.ts:92-131`) has no `stagedInputs`; `validateAndInit`
  (`:422-469`) only mkdirs the run dir + opens the charge. (Its docstring's
  "materialize input data" claim at line 10 is stale/aspirational.) Execute-analysis
  consumes the tree the data-profile pass / embedder already staged.
- Neither `triggerDataProfile` nor `StagedInput` is exported from the barrel
  (`harness/src/index.ts` — grep-verified). Deep imports
  (`@inflexa-ai/harness/tasks/data-profile.js`, `…/execution/staged-input.js`) are
  sanctioned by design — harness/CLAUDE.md: "Every deep subpath … stays importable;
  the barrel is additive, not a wall." Still, the barrel is the *curated embedder
  surface*, and the trigger + manifest type are embedder-facing — adding them to the
  barrel is the consistent move.

## 2. Paths: one physical placement, three read surfaces

The single requirement: place each selected file at

```
{sessionsBasePath}/{analysisId}/data/inputs/{mountName}/{key}
```

Then:
1. **Sandbox** — `mount-plan.ts:77-97` + `docker-client.ts:113-120` bind-mount
   `{sessionsBasePath}/{analysisId}` **read-only at `/{analysisId}`**, with a nested
   **read-write** mount of the step dir at `/{analysisId}/runs/{runId}/{stepId}`
   (subdirs `output scripts figures logs notebooks`, `mount-plan.ts:14`; container
   workdir = the writable step path). Agent sees inputs at
   `/{analysisId}/data/inputs/local/{key}`. The canonical relative address is
   `inputArtifactPath(f) = "data/" + f.relativePath` (`data-profile.ts:110-113`).
2. **Host read surface** — `WorkspaceFilesystem` reads the same tree directly
   (`workspace/filesystem.ts:117-160`); the OSS build omits the presigned-download
   fallback ("files are local").
3. **Outputs come back by NOT moving**: there is **no file-transfer endpoint** at all.
   Go sandbox-server endpoints are `GET /health`, `POST /exec`, `POST /exec/{pid}/kill`,
   `GET /preview/...` (`main.go:405-415`; greps for upload/download/ServeFile = zero).
   Exec results return via HMAC callbacks carrying exit/stdout/provenance — never file
   bytes. Output files simply persist in the RW-mounted step dir; the cli reads
   `{sessionsBasePath}/{analysisId}/runs/{runId}/{stepId}/…` from host disk.

## 3. What the cli must build (the seam, concretely)

1. **Choose `sessionsBasePath`.** ~~Deliberate decision needed: per-analysis vs
   global.~~ **RESOLVED (embed-harness-runtime D2): global, and per-analysis is
   impossible** — workflow deps (including `sessionsBasePath`) are closed over at
   registration, once per process, and DBOS forbids registering a workflow name twice,
   so the base cannot vary by analysis. Implemented as `env.sessionsDir` =
   `{dataDir}/inflexa/sessions` (`cli/src/lib/env.ts`); the stash's
   `resolveOutputDir`-based `sessionTreeRoot` design was written pre-merge and did not
   account for registration-time closure. Surfacing session trees next to the anchor
   is a later UX concern, not a mount concern.
2. **Relocate the staging module** (`src/modules/staging/` → `cli/src/modules/staging/`;
   it cannot compile where it sits — imports resolve only under `cli/src`). Verdict
   detail in `05-prior-work.md` §3.
3. **Call it with the right targetDir — old doc §6 is WRONG here:**
   `stageInputs(analysis.id, join(sessionTreeRoot(analysis), "data"))`.
   `stageSingleFile` already writes `{targetDir}/inputs/local/{key}`
   (`staging.ts:93-95`), so passing the stash's `dataInputsDir()` (= `…/data/inputs`)
   would produce `data/inputs/inputs/local/{key}`. Fix either the helper or the call
   site; the JSDoc on `stageInputs` (`:124`) already says targetDir =
   `{sessionTreeRoot}/data`.
4. **Trigger the profile** with the returned manifest; a later `executeAnalysis` run
   reuses the same staged tree with no manifest.
5. **Cleanup is cli-owned** — the harness never deletes inputs.

## 4. Mechanism: hardlink-first stays right

`stageFile` (`staging.ts:49-62`): `linkSync` → `copyFileSync` on cross-filesystem
failure. Symlinks remain wrong — the Docker bind mount would expose dangling host
symlinks inside the container; hardlinks share the inode and read as regular files.
The tree is mounted RO into the sandbox, so hardlinked originals can't be mutated by
the agent (`docker-client.ts:113` `:ro`).

## 5. Unresolved layout question (integration must pick)

`workspace-layout/spec.md:27-31` says "per-file directories under `data/inputs/`" and
harness prompt examples use `data/inputs/{fileId}/…` (`data-profile-schemas.ts:14`,
`prompts/sandbox/ephemeral-executor.ts:28`), while the cli staging draft produces
`data/inputs/local/{key}`. **The harness enforces neither** — it addresses files purely
by the `relativePath` the embedder supplies. But prompts that show the agent
`{fileId}/`-style examples while the real tree is `local/{key}`-style could confuse the
model. Options: (a) keep `local/{key}` and fix the spec/prompt examples; (b) switch
staging to `{fileId}/{fileName}`. Recommend (a) — human-readable paths in the sandbox,
and `key` preserves the user's directory structure for multi-file datasets.
Related: `harness/CLAUDE.md` layout contradicts the code on `dataprofile/` placement,
and profiling output actually goes to the DB ledger + vector store, not a
`data/dataprofile/` dir (`data-profile.ts:341-351`).

## 6. Verification of old `02-file-materialization.md` (summary)

Still true: the StagedInput contract + field-for-field wire compatibility; the RO-tree +
nested-RW-step mount model; step subdirs; hardlink rationale; `prov.input_added` events.
Stale/wrong: staging module location ("exists in working tree" — it's an untracked,
non-compiling root-`src/` draft); `executeAnalysis(…manifest…)` (takes none);
`dataInputsDir` wiring (§3.3 double-segment); `data/dataprofile/` output dir (doesn't
exist); "provenance emitted back via Bus" (harness side is the ArtifactRegistry seam —
the Bus is cli-only; see `03-provenance-migration-plan.md`).

## Gaps

- The `resolveOutputDir → sessionsBasePath` mapping is design synthesis, not observed
  code — nothing wires it today.
- K8s mount path not fully read (out of scope for same-machine cli embedding); Docker
  path fully verified.
