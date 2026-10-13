# Tasks

Run each command on the local Bun 1.4.2. Make sure that `bun --version` gives `1.4.2` before you start. Do not install or switch Bun.

## 1. The pin and the workflow comments (D1, D4)

- [x] 1.1 Set `.bun-version` at the repository root to `1.4.2`. Make sure that the file holds the one line `1.4.2`.
- [x] 1.2 In each file of `.github/workflows/`, replace "rather than seven." with "rather than one edit for each job." in the comment above the setup-bun step. Make sure that `rg -n "rather than seven" .github` gives no match, and that each setup-bun step still has `bun-version-file: .bun-version`.

## 2. The types of Bun (D2)

- [x] 2.1 In `harness/` and in `prov-kernel/`, run `bun update @types/bun --minimum-release-age=1209600`. Make sure that `git diff` of each bun.lock changes only the `@types/bun` and `bun-types` entries to 1.4.2, plus the removal of the nested `bun-types/@types/node` entry in harness. Make sure that each package.json has no change.
- [x] 2.2 In `cli/`, run the same command. Make sure that the bun.lock diff has the same shape as in 2.1, with the nested entry removed, and that `cli/package.json` has no change. Then run `bun run harness:local` and `bun run kernel:local` again, because the update replaces the links in `cli/node_modules/@inflexa-ai/`. Make sure that `cli/node_modules/@inflexa-ai/harness` and `cli/node_modules/@inflexa-ai/prov-kernel` are links again.
- [x] 2.3 Run `bun install --frozen-lockfile` in `harness/` and in `prov-kernel/`. Make sure that each exits 0 and that no bun.lock changes. In `cli/`, run the same command, then run `bun run harness:local` and `bun run kernel:local` again. Make sure that `node_modules/@types/bun/package.json` gives version 1.4.2 in each subsystem.

## 3. The proofs of the version-named comments (D3)

- [x] 3.1 Write the `timeout: false` probe of D3 under `tmp/claude/` and run it in the background. Record the time and the result of each fetch. D3 gives the expected result of each fetch. If both results occur, edit the comment in `harness/src/providers/ai-sdk.ts` as D3 tells. Otherwise, stop and report the result.
- [x] 3.2 Write the `NO_PROXY` probe of D3 under `tmp/claude/`, with each case in a new child process. Record the result of each case. Edit the JSDoc of `ensureLoopbackProxyBypass` in `cli/src/modules/embedding/local-provider.ts` as D3 tells for that result.
- [x] 3.3 Run `bun run format:file` on each source file that 3.1 or 3.2 changed, from the directory of its subsystem. Make sure that `git diff` of each file shows only the comment change.

## 4. Verification on 1.4.2 (D5)

- [x] 4.1 In `harness/`, run `bun run build`, `bun run typecheck`, and `bun run lint`. Make sure that each exits 0.
- [x] 4.2 In `prov-kernel/`, run `bun run build`, `bun run typecheck`, `bun run lint`, `bun test`, and `bun run smoke`. Make sure that each exits 0.
- [x] 4.3 In `cli/`, run `bun run typecheck`, `bun run lint`, and `bun run docs:gen`. Make sure that each exits 0.
- [x] 4.4 In `cli/`, run `bun run build` with the placeholder variables of D5. Make sure that the build ends with the smoke-test line of the host binary. Do not run the binary for any other command.
- [x] 4.5 In `harness/`, run the full suite one time with `bun run test:full`. Make sure that it has no failure.
- [x] 4.6 In `cli/`, run the full suite one time with `bun run test`. Make sure that each failure comes from the environment of the machine. The "Verification" section of `design.md` names the cause and the proof of each one. The known one is `the composed layout stays in parity with the provisioner layout`, whose output names the missing `packaging` module.
- [x] 4.7 Report to the coordinator the result of each probe and of each check of this group, as it occurred. The coordinator writes them in a "Verification" section of `design.md`.
