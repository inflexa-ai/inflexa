# Proposal: bio-api-schema-truth

## Why

The bio and research API clients validate each response with a zod schema, but many schemas do not match the wire. A live audit of all 30 clients found 15 paths that fail on every call. It also found about 25 paths that give wrong or empty data in silence. A user saw one instance as a `chembl` tool error, "schema error (not retryable)". Issue #44 records the cause of the escape: no schema has a test against a real payload.

The audit evidence is a truth map with saved payloads for each provider. The map gives, for each declared field: the published type, the observed wire behavior, and a verdict. It also gives the absence policy of each provider. For example, ChEMBL always sends an explicit `null`, and PubChem always omits the key.

## What Changes

- Correct each mismatched schema so that it mirrors the published provider schema, or the sampled wire truth. Do not widen a field without evidence.
- Delete each dead field. Move each wrong-level field to its real level. Rename each wrong-name field to the wire name.
- Route each string-serialized number through one shared helper.
- Let `apiFetch` retry 502 and 504 next to 429 and 503, because a gateway failure is transient.
- Repair the nine broken endpoint paths:
  - the dead ChEMBL `/drug/search` arm
  - the moved PharmGKB host (`api.clinpgx.org`)
  - the Context7 routes and field names
  - the retired Open Targets expression query
  - the removed GWAS trait-search endpoint
  - the missing QuickGO `includeFields=goName` parameter
  - the invalid ClinicalTrials.gov `filter.phase` parameter
  - the Ensembl homology route that is in outage
  - the invalid ClinVar term (the valid term is `clinsig_vus`)
- Repair the confirmed silent-data paths: the KEGG gene-pathway search, the EMA list separator, the Semantic Scholar `CorpusId` read, and the cBioPortal field names.
- Add golden-fixture regression tests: for each schema, one positive real payload and one negative drift fixture, table-driven and offline.
- Add live integration tests for the bio providers, gated by an environment variable.
- Add a refresh script. The script pulls live payloads and published provider schemas again, and it diffs them against the fixtures.
- Rebuild the two key-blocked clients on confirmed secondary evidence, marked as unverified: DrugBank moves to the Discovery API, and DisGeNET moves to its v1 API. The CompTox contract is corrected in place, because EPA's own server source settled it.

## Capabilities

### New Capabilities

- `bio-api-schema-fidelity`: the contract that each external-API zod schema mirrors the truth of its endpoint. It covers the evidence order (published schema, then sampled wire), the per-provider absence policy, the shared wire-number rule, and the prohibition of dead, wrong-name, and wrong-level fields. It also covers the unverified marker for a key-blocked contract, and the `Logger` rule for a silent degradation site.

### Modified Capabilities

- `chembl-tools`: the `get_drug_info` requirement changes. The `/drug/search.json` endpoint does not exist, and the `drug` resource cannot give names or indications. The drug lookup contract moves to the molecule-search path, with an indication path decided in design.
- `pubchem-tools`: the cross-references requirement changes, because `RegistryID` and `SourceName` are not parallel arrays. The bioassay requirement changes, because the wire serves plain string arrays for `Columns` and `Cell`. The compound requirement changes, because the wire key is `ConnectivitySMILES` and a nonexistent CID returns HTTP 200.
- `integration-tests-external-api`: a third tier is added — golden-fixture schema tests with a refresh script — and the live tier gains an opt-in gate for keyless bio providers.
- `context7-sandbox-integration`: the `queryDocs` route requirement changes, because the `/docs` endpoint does not exist. The real route is the library path with a `topic` parameter, and the search field is `title`.

## Impact

- Code: the 30 client files under `src/tools/lib/`, the tools under `src/tools/bio/` and `src/tools/research/`, `src/literature/sources/semantic-scholar.ts`, and the fixture and script additions.
- Behavior restored, no interface change: target-assessment modulator collection, dossier sibling data, and the identifier-resolver coverage flags.
- Documents: the harness `CLAUDE.md` testing note that names `src/__tests__/integration/` is stale against the `integration-tests-external-api` spec, and the correction rides in this change.
- Dependencies: none added.
- Evidence inputs: the truth map (`truth-map/00-summary.md`) and about 200 saved payloads in the session scratchpad. The fixture task copies the selected payloads into the repository, because the scratchpad does not persist.
