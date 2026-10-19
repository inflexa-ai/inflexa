# Tasks

## 1. The release date and the comparator

- [x] 1.1 In `src/modules/proxy/models.ts`, add the exported release-time function of design D1, and export `byRecencyThenId` with no change. Make `listModelCandidates` read the two date fields through that function. Add these cases to `src/modules/proxy/models.test.ts`, and make sure that the file passes:
  - `created_at`, `created`, and the precedence of `created_at`
  - the epoch value and a time before the epoch
  - an invalid string, a value of a different type, and an absent field
  - a finite time that a JavaScript `Date` cannot represent
  - a `created_at` in the `/models` answer of `listModelCandidates`

## 2. The model listing

- [x] 2.1 In `src/modules/harness/model_listing.ts`, add the date fields to the schema with `.nullish().catch(null)`, and add `releasedAt: string | null` to `ListedModel`. Sort the models with `byRecencyThenId` (design D2). Add tests to `src/modules/harness/model_listing.test.ts` for each spec scenario of the release date, the epoch date, and the newest-first order. Make sure that the file passes.
- [x] 2.2 Add the page loop of design D3 for a direct connection on the Anthropic protocol, with the two credential branches. Add these cases to the listing tests, and make sure that the file passes:
  - `limit=1000` on the first request, and the `after_id` of the next page
  - the page loop under a configured `auth` block on the Anthropic protocol
  - the end at `has_more: false`, at a repeated `last_id`, and at the page cap
  - a failed later page
  - no `limit` for the cliproxy mode and for the OpenAI-compatible protocol

## 3. The wire type and the route

- [x] 3.1 Add `releasedAt: string | null` to `ListedModelView` in `src/api/machine.ts`, and copy it in the `GET /models` route of `src/server/routes/machine.ts`. Update each `ListedModel` fixture of `src/server/routes/machine.test.ts`, and assert `releasedAt` in the `GET /api/v1/models` test, and update the `listed` helper of `src/tui/model_picker.render.test.tsx`. Make sure that the two files pass.

## 4. The direct setup

- [x] 4.1 In `src/modules/infra/setup.ts`, add the date fields to `probeModelsSchema`. Change `CredentialProbeResult.listedModels`, `fetchDirectListing`, and `directModelPrefill` to carry `ModelCandidate[] | null` (design D4). Update the probe and pre-fill tests of `src/modules/infra/setup.test.ts`, and add the scenario "The direct setup pre-fills the newest listed model". Make sure that the file passes.

## 5. Verification

- [x] 5.1 Run `bun run format:file` on the changed source files, then `bun run typecheck` and `bun run lint`. Make sure that no typecheck error and no lint finding comes from the change. Result: lint is clean. Typecheck has errors only in these files, which the change does not touch:
  - `src/modules/harness/prov_bridge.ts`, `src/modules/prov/prov.ts`, and `src/types/prov.ts`
  - the cause is the old installed copy of `@inflexa-ai/prov-kernel`, which has no `ProvPlanApprovalRef`
- [x] 5.2 Run the full suite one time with `bun run test`. Make sure that no test failure comes from the change. Result: 2 tests fail, and the change does not touch their files:
  - `src/modules/prov/prov.test.ts`, because of the same old prov-kernel copy
  - `src/modules/libs/composition.test.ts`, because the host `python3` has no `packaging` module
