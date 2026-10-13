# Upgrade the pinned Bun version (#663)

## Why

On 2026-10-13, the `test (cli)` job of #662 stopped in Bun 1.3.14, not in a test. Bun gave "Segmentation fault at address 0xFFFFFFFFFFFFFFF8", then "Illegal instruction", and the job ended with exit code 132. A run of the same job again passed with no change. The crash agrees with oven-sh/bun#27312, a crash of the JavaScriptCore (JSC) garbage collector during `bun test` on Linux x64. That issue is open, and it has reports for 1.3.14.

`.bun-version` pins 1.3.14, which is the last 1.3 release. Thus each CI job and each release binary keep that runtime until the pin changes.

The upgrade can decrease the crash, but it is possibly not a full fix:

- oven-sh/bun#41857 (open) reports heap corruption on 1.4.3-canary. One report in it measures a crashed test worker in 6 of 50 runs on 1.4.2.
- oven-sh/bun#40607 (open) reports a crash of the parallel garbage-collector marker on 1.4.0.
- No release note of 1.4.0, 1.4.1, or 1.4.2 claims a fix for oven-sh/bun#27312.

## What Changes

- `.bun-version` names `1.4.2`. Bun 1.4.2 (2026-09-05) is the newest release that is older than two weeks. Bun 1.4.3 (2026-10-10) is too new. Each CI job installs 1.4.2, and `release.yml` builds the cli binaries with it. **The release binaries embed Bun 1.4.2 in place of 1.3.14.**
- The bun.lock files of cli, harness, and prov-kernel lock `@types/bun` and `bun-types` at 1.4.2. Each package.json keeps its `"latest"` specifier.
- Each code comment that names 1.3.14 as the proof of a current Bun behavior gets a new proof on 1.4.2. The comment then names 1.4.2, or it loses the sentence when the behavior is gone:
  - the `timeout: false` lift of the 300-second idle cut in `harness/src/providers/ai-sdk.ts`
  - the `NO_PROXY` delete-then-set quirk in `cli/src/modules/embedding/local-provider.ts`.
- The setup-bun comments of the workflows lose the stale count "rather than seven".

These items are not in scope:

- a garbage-collector mitigation in CI, for example `BUN_JSC_numberOfGCMarkers=1`
- an automatic retry of a test job
- a change of a different dependency.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. No spec owns the Bun pin. The harness requirement "The harness supplies the Bun transport lift" (`harness/openspec/specs/ai-sdk-provider-runtime/spec.md`) stays true when the probe of design D3 passes on 1.4.2. Thus `.openspec.yaml` sets `skip_specs: true`.

## Impact

- `.bun-version` at the root.
- `.github/workflows/`: the comment beside each setup-bun step that carries the count.
- `cli/bun.lock`, `harness/bun.lock`, and `prov-kernel/bun.lock`: the `@types/bun` and `bun-types` entries.
- `harness/src/providers/ai-sdk.ts` and `cli/src/modules/embedding/local-provider.ts`: one comment each.
- No package.json change, no new dependency, no migration, and no wire type change.
- The change lives in the cli spec tree, because the root has no spec tree and the crashed job is `test (cli)`. The edits outside `cli/` are the root pin, the workflows, the lockfiles of harness and prov-kernel, and the harness comment.
