# Tasks

## 1. The slug family

- [x] 1.1 Make `src/lib/slug.ts` with `slugify(value, opts?)`, a colocated test in `src/lib/test/slug.test.ts`, and run that test
- [x] 1.2 Migrate `tasks/data-profile-index.ts` and `tasks/data-profile-resolve.ts` to `slugify`, and run `bun test src/state/test/data-profile.test.ts src/tasks/test`
- [x] 1.3 Migrate `schemas/validate-plan.ts`, `lib/regulatory-corpus/fetch-ich.ts`, and `sandbox/execution-id.ts`, and run `bun test src/schemas src/sandbox/test/execution-id.test.ts src/lib/regulatory-corpus`
- [x] 1.4 Confirm the `state/test/data-profile.test.ts` `slugOf` mirror stays out of the family, because it keeps underscores and a trailing dash per the vector-store key contract, and run `bun test src/state/test/data-profile.test.ts`

## 2. Production clone clusters

- [x] 2.1 Extract `axesOf` and `slotGroupsOf` in `report-render/chart.ts`, and run `bun test src/report-render/test/chart.test.ts`
- [x] 2.2 Extract `scripts/stage-report-page.ts`, migrate `render-fixture.ts` and `render-gallery.ts`, and verify with `bun run typecheck` and `bun run design:fixture`
- [x] 2.3 Extract the tool-event emitter in `loop/run-loop.ts`, and run `bun test src/loop/test`
- [x] 2.4 Spread one `destinationFields` fragment in `tools/report-authoring/authoring-tools.ts`, and run `bun test src/tools/report-authoring`
- [x] 2.5 Extract the `rowsEnvelope` and `scoresField` combinators in `tools/lib/opentargets-client.ts`, and run `bun test src/tools/lib`

## 3. Test scaffold clusters

- [x] 3.1 Give the report-session suites one tool builder, and run `bun test src/tools/report-session`
- [x] 3.2 Give the client suites shared stubs in `src/tools/lib/__fixtures__/`, and run `bun test src/tools/lib src/tools/bio`
- [x] 3.3 Give the PDF builder one home in `src/lib/test/`, and run `bun test src/tools/research/test/web-fetch.test.ts src/tools/script/test/file-tools.test.ts`
- [x] 3.4 Give the stream-model builder one home in `src/loop/test/`, and run `bun test src/loop/test/metrics.test.ts src/loop/test/usage-accounting.test.ts`
- [x] 3.5 Collapse the sandbox probe repeats in `sandbox/test/docker-client.test.ts` and the docker-k8s pair, and run `bun test src/sandbox/test`
- [x] 3.6 Collapse the tasks and workflows context builders (pause, suspension, settle-notice, chat-turn, dbos pause, execute-analysis, sandbox-step), and run `bun test src/tasks/test src/workflows src/app/test/chat-turn-workflow.test.ts`
- [x] 3.7 Collapse the remaining self-clones and cross-file pairs that the gate reports (figures, runtime, state, memory, input-scan, providers, report-model, execution, research, provenance, tools), and run `bun test` on each touched tree

## 4. The floor and the full gate

- [x] 4.1 Set `minTokens: 60` and `minLines: 15` in `harness/.jscpd.json`, rewrite the floor reason with the measured ladder, and run `bun run dupes` to zero; extract what the real gate still reports, and run `bun run dupes` again
- [x] 4.2 Run `bun run lint` and `bun run typecheck` in harness, and make both pass
- [x] 4.3 Run `bun test` once in harness, and make it pass with no new failure
