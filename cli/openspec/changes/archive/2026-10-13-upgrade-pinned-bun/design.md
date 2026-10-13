# Design

## Context

Refer to `proposal.md` for the reason.

- Each workflow step that installs Bun uses `oven-sh/setup-bun` with `bun-version-file: .bun-version`. The steps are in `test.yml`, `lint.yml`, `release.yml`, `release-npm.yml`, `release-harness.yml`, `release-prov-kernel.yml`, and `release-bump.yml`. Thus the one file sets the Bun of CI and of the release build.
- `cli/scripts/build.ts` compiles the release binaries with `Bun.build` and `compile.target` `bun-<os>-<arch>`. Bun downloads the runtime of each target, at the version of the Bun that runs the build. Thus the pin also sets the runtime that each binary embeds. The SBOM step fetches `LICENSE.md` at the tag `bun-v<Bun.version>`.
- No package.json declares `engines.bun` or `packageManager`. Each package.json declares `"@types/bun": "latest"`, and each bun.lock locks `@types/bun@1.3.14` and `bun-types@1.3.14`.
- The local Bun of the developer machine is 1.4.2 already. Code from 2026-10-03 (`cli/src/server/http.ts`, `cli/src/server/routes/machine.test.ts`) describes Bun 1.4.0 behavior. Thus the suites run on 1.4.x locally, while CI runs 1.3.14.
- Bun 1.4.2 has a release asset for each target of `build.ts`, and `raw.githubusercontent.com/oven-sh/bun/bun-v1.4.2/LICENSE.md` exists.

## Goals / Non-Goals

**Goals:**

- CI, the release build, and the developer machines use one Bun version again.
- The types of each subsystem describe the runtime that its jobs run.
- Each comment that names the pinned version as a proof is true for the new pin.

**Non-Goals:**

- A proof that the crash of oven-sh/bun#27312 stops. One CI run cannot show it, and the upstream reports show the crash class on 1.4.x.
- A change of the Bun behavior that the code depends on. If a proof of D3 fails, the work stops for a decision.

## Decisions

### D1. Pin Bun 1.4.2

Set `.bun-version` to `1.4.2`.

- 1.4.3 (2026-10-10) is less than two weeks old. The issue does not permit it.
- 1.4.0 and 1.4.1 are older, but 1.4.2 fixes two regressions of 1.4.1: a `bun build` variable collision and an `AsyncLocalStorage` leak. The three releases are in the same minor line, thus the behavior changes of 1.4 apply to each of them.
- Bun 1.3.14 is the last 1.3 release, and oven-sh/bun#27312 has reports for it. Thus a 1.3 pin cannot change the crash.

### D2. Lock `@types/bun` at 1.4.2 and keep `"latest"`

In each subsystem, run `bun update @types/bun --minimum-release-age=1209600`. The age of 14 days excludes `@types/bun@1.4.3` (2026-10-12), thus `"latest"` resolves to 1.4.2.

A test of this command on copies of the manifests changes only these lockfile entries:

- `@types/bun` and `bun-types` go from 1.3.14 to 1.4.2.
- In cli and harness, the nested `bun-types/@types/node` entry goes away, because `bun-types` now shares the direct `@types/node` of the subsystem.

The alternatives:

- A plain `bun update @types/bun` locks 1.4.3. That version is too new, and it does not agree with the 1.4.2 runtime.
- A specifier of `"1.4.2"` in each package.json changes the dependency policy of the repository. The issue does not ask for that.
- The 1.3.14 types stay correct for the typecheck today, but they describe a runtime that no job runs after D1.

The current bun.lock files use `lockfileVersion: 1`. Bun 1.4.2 accepts them with `bun install --frozen-lockfile` and does not write them again.

### D3. Prove the version-named comments again on 1.4.2

Each probe is a scratch script under `tmp/claude/` at the repository root. It runs on the local Bun 1.4.2, with no LLM provider and no inflexa session.

**The `timeout: false` lift** (`harness/src/providers/ai-sdk.ts`, the comment above `forwarded`). In Bun 1.4.2, the default idle timeout of a fetch is still 300 seconds, but `HTTPThread::on_start` (`src/http/HTTPThread.rs`) stores it through `normalize_idle_timeout_seconds` (`src/http/lib.rs`). That function pads a value above 240 seconds to the next minute plus one minute, thus 300 becomes 360 on the minute timer wheel. The cut then fires between 300 and 360 seconds. A response held for 310 seconds can thus arrive before the cut.

A local `Bun.serve` with `idleTimeout: 0` runs in a child process and holds its response for 420 seconds. Two fetches start at the same time:

- a fetch with no `timeout` key, expected to fail with a timeout error after more than 290 seconds and before the response at 420 seconds
- a fetch with `timeout: false`, expected to get the response after 420 seconds.

Record the elapsed time and the error text of each fetch. If both results occur, the comment credits the probe on Bun 1.4.2. It then gives the measured time of the cut, the reason for the padding, and the time of the request with the key. If a result differs, stop and report it. The harness requirement "The harness supplies the Bun transport lift" depends on this behavior.

**The `NO_PROXY` quirk** (`cli/src/modules/embedding/local-provider.ts`, the JSDoc of `ensureLoopbackProxyBypass`). Each case runs in a new child process, because the environment of a process keeps its state. A local proxy server records each request that it gets, and a target server answers on `127.0.0.1`.

In each case, the child starts with `HTTP_PROXY` and `http_proxy` set to the proxy, and the fetch goes to the target:

- Case A: `NO_PROXY` and `no_proxy` are not set. The fetch must reach the proxy, or the probe cannot show anything.
- Case B: `NO_PROXY` is not set at the start. The child sets `process.env.NO_PROXY = "127.0.0.1"` with no delete. The fetch must go direct.
- Case C: `NO_PROXY` starts with a different host, for example `example.invalid`. The child does `delete process.env.NO_PROXY`, then `process.env.NO_PROXY = "127.0.0.1"`.

Case C gives a verdict only when case A reaches the proxy and case B goes direct. The results set the edit:

- If case C reaches the proxy, the quirk stays. Change "verified on 1.3.14" to "verified on 1.4.2".
- If case C goes direct, the quirk is gone on the pinned runtime. Remove the sentence that starts with "Assignment only, never delete-then-set:", to the end of the JSDoc text. The assignment-only code stays, because it is correct on each version.
- If case A or case B does not give its expected result, the probe is not valid. Keep the comment, and record the result.

The other comments with a version stay. `store_download.ts` names a 1.3.10 fault as history. `setup_answers.ts` names a floor ("Bun 1.3+"). `http.ts` and `machine.test.ts` describe 1.4.0 behavior that the 1.4.2 suite proves.

### D4. Remove the stale count from the setup-bun comments

The comment says "a bump is one reviewable edit rather than seven". The number of call sites changes when a workflow adds one, and the count is already wrong. Write "rather than one edit for each job". The rest of the comment stays.

### D5. Verify on 1.4.2

- `bun install --frozen-lockfile` passes in cli, harness, and prov-kernel.
- harness: `bun run build`, `bun run typecheck`, `bun run lint`, and the full suite one time with `bun run test:full`.
- prov-kernel: `bun run build`, `bun run typecheck`, `bun run lint`, `bun test`, and `bun run smoke`.
- cli: the links of `bun run harness:local` and `bun run kernel:local`, then `bun run typecheck`, `bun run lint`, `bun run docs:gen`, and the full suite one time with `bun run test`.
- cli: one host build with `bun run build`. It smoke-tests `--version` of the host binary. This is the only local proof of the compile path. The cross-compiled targets get their first build in `release.yml`.
- The host build refuses to start without each variable that `bakedEnv` in `src/lib/env.ts` reads. Give these placeholders:
  - `INFLEXA_BUILD_CHANNEL=development`
  - `INFLEXA_AUTH0_DOMAIN=example.invalid`
  - `INFLEXA_AUTH0_CLIENT_ID=placeholder`
  - `INFLEXA_AUTH0_AUDIENCE=https://api.example.invalid/`. The audience must parse as a URI and must not be the Management API of the domain, or `audienceInvalidReason` stops the build.

A failure of `the composed layout stays in parity with the provisioner layout` (`cli/src/modules/libs/composition.test.ts`) on the developer machine is not a defect of this change. The host python3 has no `packaging` module.

## Verification

These results occurred on the developer machine with Bun 1.4.2 (`744846f84`), macOS arm64.

- D2: `bun update @types/bun --minimum-release-age=1209600` changed only the entries that D2 names, in each bun.lock. No package.json changed. `bun install --frozen-lockfile` then exits 0 in each subsystem with no lockfile change.
- D3, the `timeout: false` lift:
  - A first probe held the response for 310 seconds, once in one process and once with the server in a child process. Both fetches got the response, because the padded cut of 1.4.2 had not fired yet.
  - The probe of D3 (a 420-second hold, the server in a child process) gave the two expected results. The fetch with no key failed with `TimeoutError` (code 23, "The operation timed out.") after 360162 ms. The fetch with `timeout: false` got the response after 420006 ms.
  - Thus the comment in `ai-sdk.ts` now credits the probe on Bun 1.4.2. It says that the cut comes past the default of 300 seconds, and that it fired at 360 seconds because Bun pads the timer. It also says that the request with the key completed after 420 seconds.
- D3, the `NO_PROXY` quirk: case A reached the proxy, and case B went direct. Case C reached the proxy, thus the quirk stays on 1.4.2. A control with read-append-assign and no delete went direct. The JSDoc now says "verified on 1.4.2".
- D4: no file under `.github/` has "rather than seven". Each setup-bun step keeps `bun-version-file: .bun-version`.
- D5:
  - harness: `build`, `typecheck`, and `lint` pass. `bun run test:full` gives 5636 pass, 21 skip, 0 fail.
  - prov-kernel: `build`, `typecheck`, `bun test` (119 pass), and `smoke` pass. `lint` passes with the installed tsprov. It fails with type-aware errors in `src/lineage.ts` while `kernel:local` links tsprov to the copy of cli. The tsprov version is 0.5.1 on both sides, and the CI lint job of prov-kernel does not make the link.
  - cli: `typecheck`, `lint`, and `docs:gen` pass. The host build ends with `smoke test: --version → 0.24.0`.
  - cli: `bun run test` gives 3875 pass, 2 skip, 3 fail. Each failure comes from the environment of the machine:
    - The parity test fails because the host python3 has no `packaging` module.
    - The two tests of `the base folders of the data and the configuration` (`src/lib/env.test.ts`) fail with exit code 127. They spawn `bun` by name with `HOME` set to a temporary folder. The `bun` on the PATH of this machine is a wrapper script that needs `$HOME/.nvm`. With the real Bun 1.4.2 binary first on the PATH, `src/lib/env.test.ts` gives 41 pass and 0 fail.

## Risks / Trade-offs

- [The crash continues on 1.4.2] → This change does not claim a fix. The proposal states the upstream evidence. A CI mitigation is a non-goal.
- [The release binaries change runtime] → Bun 1.4 changes `Bun.serve`, `fetch`, `Bun.spawn`, `bun:sqlite`, `bun build --compile`, and some `node:` modules. The production local server never calls `server.stop()` (`cli/src/server/serve.ts`), thus the 1.4 change of `stop()` touches the tests only. The full suites on 1.4.2, the host build, and the release gate (`release.yml` runs the cli typecheck and tests, and smoke-tests the linux-x64 binary before the tag) are the controls.
- [A cross-compiled target fails] → Only `release.yml` builds each target. A failure there stops the release before the tag.
- [`"latest"` moves to 1.4.3 at the next `bun update`] → This is the current policy of the repository. This change does not alter it.
- [The `timeout: false` probe takes 7 minutes] → Run it in the background, beside the other work.
