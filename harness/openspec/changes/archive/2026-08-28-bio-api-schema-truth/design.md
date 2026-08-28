# Design: bio-api-schema-truth

## Context

A live audit measured all 30 zod-validated API clients against their providers. The evidence is a truth map with about 200 saved payloads, one replay harness, and a verdict for each declared field. The audit found three defect classes. First, over-strict schemas reject real payloads, and the tool call fails. Second, dead or misplaced fields make the tool return wrong or empty data in silence. Third, some endpoints moved or retired, and the client still calls the old path.

The truth map lives at `truth-map/00-summary.md` in the session scratchpad, with six per-group detail files. The scratchpad does not persist, thus the fixture task copies the evidence into the repository.

## Goals / Non-Goals

**Goals:**

- Each schema mirrors the truth of its endpoint, with evidence.
- Each of the nine broken endpoint paths works again.
- A regression on any schema fails an offline test on the next `bun test`.
- A future provider drift is visible through the refresh script and the live test tier.
- A silent degradation site reports its unexpected cause through the `Logger` seam.

**Non-Goals:**

- No new provider and no new tool surface.
- No key acquisition for DrugBank, CompTox, or DisGeNET.
- No change to the error model of `apiFetch`, and no change to `isUnexpectedApiError`. The one exception is the retry set of D12, which gains 502 and 504.
- No repair of the pre-existing spec drift about tool names (the consolidation of 17 tools into 5). That belongs to a spec-compaction pass.

## Decisions

### D1 — Evidence order for each field modifier

A modifier comes from the published machine schema of the provider when one exists. When none exists, it comes from the sampled wire truth in the fixtures. A field is not widened without evidence. The verified oracle index is section D of the truth map. Alternative: blanket `.nullable().optional()` widening. Rejected, because it turns validation into "accept anything", and a real contract break then passes in silence.

### D2 — Per-provider absence policy

The audit proved that absence encoding is a per-provider constant. ChEMBL always sends an explicit `null` and never omits a key. PubChem always omits the key and never sends `null`. GraphQL providers follow their SDL nullability. EMA encodes absence as the empty string. The policy table (truth map, section A) is the review standard for each modifier. A schema comment at the top of each client names the policy of its provider.

### D3 — One shared wire-number helper

Tastypie serializes `decimal` as a JSON string, and the eutils `esearch` scalars are strings. The fix is one helper in `api-utils.ts` that accepts `string | number | null`, and transforms the value to `number | null` (`NaN` becomes `null`). Each affected field uses it: ChEMBL `max_phase`, `standard_value`, `pchembl_value`, `full_mwt`, `alogp`, PubChem `MolecularWeight`, Bgee `expressionScore`, and the eutils counts. Alternative: per-site unions plus `parseNumeric` at the map site (the status quo). Rejected, because the drift between sites is what produced the `max_phase` defect.

### D4 — `z.unknown()` ban for maybe-absent fields

Under zod 4, `z.unknown()` is required, not implicitly optional. The audit proved one outage from this (`CanonicalSMILES`). Each `z.unknown()` that means "maybe absent" becomes an explicit type with `.optional()`.

### D5 — The ChEMBL drug action

The `/drug/search.json` endpoint does not exist, and the `drug` resource carries no name and no indication data. The repaired path: a name query runs the molecule search with the approved-phase filter. An indication query runs the `drug_indication` resource with `efo_term__icontains` and `mesh_heading__icontains` filters, then resolves the molecules. Both verified live (755 rows for "melanoma"). The client reads the indications of returned molecules from the `drug_indication` resource. Alternative: keep a `/drug.json` filter arm. Rejected, because that resource cannot give `pref_name`, `molecule_type`, or indications.

### D6 — PubChem cross-references without the fake zip

`RegistryID` and `SourceName` are not parallel arrays, thus the index zip attributes wrong sources. The repaired contract: each entry carries the id, and the source comes from the identifier pattern of a fixed registry table: ChEMBL, DrugBank, KEGG, PDB, CAS, ChEBI, HMDB, and UNII. An unmatched id carries `source: null`. Alternative: the PUG View API, which pairs ids with sources. Rejected, because it is a heavy, different surface for a bridge use case that pattern matching serves.

### D7 — Golden fixtures, layout, and the negative twin

Fixtures live at `src/tools/lib/__fixtures__/<provider>/`, as raw JSON payloads promoted from the audit samples. Each schema gets one positive fixture that carries the observed absence encoding, and one negative `*.drift.json` twin with a genuine type break. A colocated table-driven test asserts that the schema accepts the positive fixture, maps the expected output, and rejects the twin. A large payload is excerpted to a representative subset before promotion, with its null-bearing rows kept, at a cap of about 100 KB. Alternative: a central fixtures tree far from the clients. Rejected, because colocation follows the existing test convention of the repository.

### D8 — The refresh script and the manifest

Each fixture directory carries a `manifest.json` that records, for each fixture: the request URL, the parameters, and the capture date. The script `scripts/refresh-fixtures.ts` replays the manifest, pulls the published oracle schemas again, and diffs the results against the stored fixtures. It reports drift, and it rewrites fixtures only under a `--write` flag. The script runs on demand, not in CI, thus offline CI stays offline. The replay is polite: sequential, a minimum gap of 300 ms, and the NCBI cap of 3 requests each second. A manifest entry can name ignore-paths for volatile fields (a timestamp, a total count), and the diff skips them.

### D9 — The live tier gate for keyless providers

Real-upstream tests stay under `src/providers/integration/` per the existing spec. A key-gated provider keeps its key gate. A keyless bio provider gains the opt-in gate `describe.skipIf(!process.env.CORTEX_LIVE_API_TESTS)`. Without the gate, a keyless block runs on every clean checkout, and CI then depends on the network.

### D10 — Key-blocked providers

DrugBank, the CompTox container shapes, and DisGeNET are not verifiable without keys. A research pass collects secondary evidence: official docs and archives, and the provider-authored client libraries whose parse code encodes the response shape. Each such client gets a conservative contract from that evidence, and a file-top comment marks the contract as unverified with the date. The DrugBank response union also stops accepting arbitrary objects: the object arm demands `drugbank_id`, thus an error envelope becomes `invalid_response` instead of one blank drug row.

The DrugBank client targets the Discovery API (`api.drugbank.com/discovery/v1`), because only that API serves the tool promise: `drugs?q=` for the name search, and the bonds routes for targets. `drug_interactions` leaves the drug record, because no Discovery route serves it. Pagination rides `per_page` (max 50) and the `X-Total-Count` header, not a `limit` parameter. The secondary evidence settled the CompTox containers (every array wrap is correct), the `hitc >= 0.9` threshold, and the DisGeNET v1 contract (base, query routes, raw-key auth, and the `{status, payload, paging}` envelope).

### D11 — Silent degradation sites report the cause

The IUPHAR and ChEMBL outages stayed invisible for months, because catch sites converted every error into an empty result. A site that degrades to an empty value keeps that behavior for an expected miss. But before it degrades on an unexpected cause, it reports the cause through the injected `Logger`. No `console` use (structured-logging spec).

### D12 — Retry set gains 502 and 504

The audit observed Monarch 502 responses with HTML bodies that are transient. `RETRYABLE_STATUSES` gains 502 and 504 next to 429 and 503. The classification of `isUnexpectedApiError` does not change.

### D13 — Small behavior repairs ride the same change

- QuickGO: the annotation URL gains `includeFields=goName` (verified live).
- ClinVar: `clinsig_uncertain` becomes `clinsig_vus` (verified, 19,046 records).
- ClinicalTrials.gov: `filter.phase` is not a v2 parameter. The phase filter moves to a post-filter over `designModule.phases`, and `countTotal=true` makes `totalFound` honest.
- GWAS: the trait search moves to `findByEfoTrait`. The `pubmedId` read moves to `study.publicationInfo.pubmedId`.
- Ensembl orthologs: resolve the id first, then call `/homology/id/`, because the symbol route is unstable and the id route serves the same envelope.
- PharmGKB: the base host becomes `api.clinpgx.org` (contract verified identical). An unknown gene returns an empty result instead of a thrown 404.
- Open Targets: the expression query moves to `baselineExpression`, with a schema for `BaselineExpressionRow`. The `gqlFetch` error path includes the first GraphQL error message.
- Semantic Scholar: `externalIds` values admit numbers, thus `CorpusId` survives.
- EMA: the medicine-list separator is `;` only.
- CompTox: the genetox summary fields move to the details endpoint or to the real summary names, per the secondary evidence of D10.
- KEGG: `find/pathway/{gene}` matches pathway names only, thus it never matches a gene. The gene membership path moves to `find/genes` plus `link/pathway`.

## Risks / Trade-offs

- [A provider drifts again after the fix] → The refresh script and the live tier make the drift visible. The goldens pin the last verified truth.
- [A negative fixture stops rejecting after a widening] → The table-driven test asserts the rejection, thus the guard cannot erode in silence.
- [Secondary evidence for a key-blocked provider is wrong] → The contract is conservative and marked unverified. The DrugBank union fix makes a wrong guess loud instead of silent.
- [Excerpted fixtures hide a row variant] → The excerpt rule keeps each observed variant class (a null-bearing row, an omission row, a biologic row), not the first N rows.
- [The ClinPGx successor diverges from the PharmGKB contract later] → The golden fixture pins the verified contract, and the refresh script diffs against the live host.

## Open Questions

None remain. The secondary-evidence pass settled the CompTox containers, the `hitc` threshold, the DisGeNET v1 contract, and the DrugBank route (D10). A live verification of DrugBank and DisGeNET stays impossible without keys, thus their unverified markers stay until a key exists.
