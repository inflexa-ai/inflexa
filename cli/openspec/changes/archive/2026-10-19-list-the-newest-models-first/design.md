# Design

## Context

Refer to proposal.md for the reason of the change. These facts of the current code control the approach:

- `listConnectionModels` (`src/modules/harness/model_listing.ts`) sends one `GET {base}/models` for each mode. Its schema keeps `id` and `capabilities` only, and it gives the models in the order of the server.
- `src/modules/proxy/models.ts` owns the default-model rank. `byRecencyThenId` sorts by `created` (Unix seconds) descending, puts a missing `created` last, and breaks a tie with the id. The module does not export it.
- `src/modules/infra/setup.ts` reads `/models` at two places: the probe ladder (`probeCredentialSource`) and the static-key attempt (`fetchDirectListing`). The two keep the ids only. Thus `directModelPrefill` gives `rankModelCandidates` no date.
- `harness/model_listing.ts` and `infra/setup.ts` already import from `proxy/models.ts`.
- The Anthropic List Models route gives `created_at` (RFC 3339), and it can give an epoch value for an unknown date. It takes `limit` (default 20, maximum 1000) and `after_id`. It gives `has_more` and `last_id`, and it lists the newest models first.

## Goals / Non-Goals

**Goals:**

- One normalization of the release date, and one comparator, for the listing route and for the setup pre-fill.

**Non-Goals:**

- The picker shows no date. The order changes, and no row changes its shape.
- No correction of a wrong date from a source, for example the wrong years of some old ids in the CLIProxyAPI registry.
- No pages for the cliproxy mode and the OpenAI-compatible protocol. Their `/models` routes give the full list in one answer.
- No pages in the setup. The Anthropic route lists the newest models first, thus the first page holds the newest model, and the pre-fill needs that model only.
- No change to the rank of the cliproxy election. Its parser uses the function of D1, and a `created` of 0 and an absent `created` already sort the same.

## Decisions

### D1. The normalization and the comparator stay in `proxy/models.ts`

`proxy/models.ts` gets one exported function that changes a source entry into a release time in Unix seconds, or `undefined`. The function reads `created_at` first, and it reads `created` when `created_at` gives no date. `created_at` must be a string, and `created` must be a number. A value of a different type gives no date, for example a numeric string in `created`. An absent value, a string that is not an RFC 3339 date-time with a valid calendar date, and a number that is not finite give no date. The `z.iso.datetime({ offset: true })` check of zod makes this decision, because `Date.parse` accepts strings such as `"0"` and moves `2026-02-30` to March. A time value of 0 or less also gives no date, and this rule covers the epoch placeholder of Anthropic. A time that a JavaScript `Date` cannot represent also gives no date, thus the ISO conversion cannot throw.

The module exports `byRecencyThenId` with no change. The listing and the setup use it through `ModelCandidate` (`{ id, created? }`), thus no copy of the comparator exists. `listModelCandidates` also reads the two date fields through the function, thus each reader of `/models` obeys one rule.

The two date fields in each schema use `.nullish().catch(null)`. Thus a date field of an unknown shape costs the date of that model only, never the listing. This is the rule that the `capabilities` field obeys.

Alternative: put the function in `harness/model_listing.ts` and import it into the setup. Rejected, because the setup then gets a new dependency on the listing module, and the rank helpers stay split across two modules.

Alternative: keep the date in milliseconds. Rejected, because `ModelCandidate.created` is in Unix seconds for the cliproxy path, and one unit for each candidate keeps the comparator correct.

### D2. The listing sorts all models, with no family filter

`listConnectionModels` changes each entry into `{ id, created }`, and it sorts the entries with `byRecencyThenId`. Then it gives `ListedModel` with `releasedAt`: the ISO 8601 form of the release time (`new Date(seconds * 1000).toISOString()`), or `null`.

`rankModelCandidates` is not the correct function here, because it keeps the preferred family only. The picker must list each model of the connection.

### D3. Pages on the Anthropic protocol in direct mode only

When the connection is direct and its protocol is `anthropic`, the first request adds `limit=1000`. This applies to the two credential branches: the configured `auth` block and the static env key. After each page, the listing reads the next page with `limit=1000&after_id=<last_id>` while these conditions are true:

- the page has `has_more: true`
- the page has a `last_id` that is not empty
- the `last_id` is different from the cursor of the page before
- the number of pages is less than a fixed cap of 10

When one of these conditions is false, the loop ends, and the listing gives the models that it read. At 1000 models for each page, the cap is far above a real catalog. The cap and the cursor comparison stop an endpoint that always reports more models.

The early end gives the models that it read, and it does not fail the listing. A gateway can ignore `after_id` and report `has_more: true` on each page. That gateway then keeps the listing of its first page, which is the listing that it gives today. A failure would remove the listing of that gateway.

The listing keeps the first entry of each id, and it ignores the same id on a later page. Thus a gateway that repeats a page gives each model one time.

One `AbortSignal.timeout(timeoutMs)` covers each page, thus the 10 s bound covers the full listing. A failed page maps to the same errors as a failed first page: a throw gives `unreachable` or `timed_out`, a non-2xx status gives `unreachable`, and a body that fails the schema gives `no_models`. An empty later page ends the loop.

The schema adds `has_more` and `last_id` as top-level fields that use `.nullish().catch(null)`.

Alternative: obey `has_more` in each mode. Rejected, because no other source of this listing pages, and the spec names the Anthropic protocol.

### D4. The setup carries the date into the rank

The probe schema of the setup adds the two date fields. `CredentialProbeResult.listedModels` and `fetchDirectListing` give `ModelCandidate[] | null` in place of `string[] | null`. `directModelPrefill` takes `ModelCandidate[] | null`, and it gives the candidates to `rankModelCandidates` with their dates. The family preference of the rank stays.

### D5. The wire type

`ListedModelView` in `src/api/machine.ts` gets `releasedAt: string | null`. The route in `src/server/routes/machine.ts` copies it. The TUI picker keeps the order of the server.

## Risks / Trade-offs

- [A gateway on the Anthropic protocol refuses the `limit` parameter] → The listing fails, and the picker falls to the free-text field with the reason. `limit` is a documented parameter of the Anthropic route, thus the risk is low.
- [A source gives a wrong date] → The order of that model is wrong. The server gives the date of the source with no correction, and the issue records the known case.
- [The page cap ends the loop early] → The listing gives fewer models than the endpoint has. This occurs only after 10 000 models.
- [The order of `GET /api/v1/models` changes for each client] → This is the purpose of the change.
