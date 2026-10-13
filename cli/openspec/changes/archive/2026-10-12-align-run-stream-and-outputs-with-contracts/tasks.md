# Tasks

Do these tasks after the tasks of the harness change of the same name, because
the cli build reads the harness `dist/` and the `prov-kernel` working copy.

## 1. Link the working copies

- [x] 1.1 From `cli/`, run `bun run harness:local` and `bun run kernel:local`. Make sure that `node_modules/@inflexa-ai/harness` and `node_modules/@inflexa-ai/prov-kernel` are links to the working copies.

## 2. Treat the suspended status as terminal

- [x] 2.1 In `src/server/durable_work.ts`, make `RUN_IS_LIVE` count a run only when its status is `running`. Correct the doc comment. Add a test to `src/server/durable_work.test.ts` for the `local-server` delta scenario "A suspended run does not block".
- [x] 2.2 In `src/tui/hooks/sidebar_live.ts`, set `suspended_insufficient_funds` to `true` in `RUN_STATUS_TERMINAL`, and correct the comment that calls the status a run that waits for a resume. Update the sidebar and run completion tests that expect a non-terminal suspended run, and make sure that a suspended run raises the run completion notice.
- [x] 2.3 In `src/server/routes/runs.test.ts`, change the test "`active=true` pages the runs that are not terminal" so that its active rows read `running` only. Make sure that the test passes.
- [x] 2.4 In `src/modules/harness/dev/run.ts`, change the outcome message of a suspended run to say that the host suspended the run and that a new run of the plan can start. Remove the false comment about the dedup. Update the test of that message if one exists.

## 3. Verify the cli

- [x] 3.1 Run `bun run format:file` on each changed file in `src/`. Run `bun run typecheck` and `bun run lint`.
- [x] 3.2 Run the changed test files. Then run the full cli suite one time with `bun run test`. The test `the composed layout stays in parity with the provisioner layout` fails locally because the host `python3` lacks `packaging`, and that failure is not a defect of this change.
