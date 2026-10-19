# Proposal

## Why

A client of `GET /api/v1/models` lists the model ids of each role in the order of the server, and the ids cannot give a newest-first order. For example, `claude-opus-5-5` has no date, and `claude-sonnet-5` and `claude-opus-5` both parse as version 5. Each source of the listing gives a release date, but the server drops it. The direct Anthropic listing also reads one page of 20 models only (issue #675). The direct-mode setup ranks the ids with no date, thus it pre-fills an old `claude-3-…` model.

## What Changes

- The model listing reads the release date of each model: `created` (Unix seconds) or `created_at` (RFC 3339). It normalizes the date to `releasedAt: string | null` (ISO 8601). An absent, invalid, or epoch value gives `null`.
- `GET /api/v1/models` gives `releasedAt` for each model. The listing comes newest first. A model with no date comes last. The ids break a tie. The terminal picker gets the same order.
- The rank uses the existing comparator of the default-model rank. The listing does not get a copy of it.
- The direct listing on the Anthropic protocol asks for the maximum page size, and it reads each next page while the endpoint reports more. The 10 s bound covers all pages together.
- The direct-mode setup carries the release date of each listed id into the rank, thus the pre-fill is the newest model of the preferred family.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-model-selection`: the listing picker requirement adds the release date of each model, the newest-first order, and the read of each page of the Anthropic listing.
- `default-model-election`: the rank requirement adds the `created_at` field and the epoch rule, and it names the direct setup listing as a consumer of the rank.

## Impact

- `src/modules/harness/model_listing.ts`: the schema, `ListedModel`, the page loop, and the sort.
- `src/modules/proxy/models.ts`: the release-date normalization and the comparator, exported for the listing.
- `src/api/machine.ts` and `src/server/routes/machine.ts`: the `releasedAt` field of `ListedModelView` and its map.
- `src/modules/infra/setup.ts`: the probe listing, the static-key listing, and `directModelPrefill` carry the date.
- The tests of these files and `src/tui/model_picker.render.test.tsx`.
- Flamme (the GUI client in a different repository) reads the new field and the new order from the same route.
