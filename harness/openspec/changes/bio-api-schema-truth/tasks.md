# Tasks: bio-api-schema-truth

Evidence for each task: the truth map at `truth-map/00-summary.md` in the session scratchpad, and the per-group files 01 to 06. The saved payloads for the fixtures are under `scratchpad/samples/<provider>/`.

## 1. Shared foundations

- [x] 1.1 Add the shared wire-number helper to `src/tools/lib/api-utils.ts`, with unit tests ("4.0" gives 4, 2001 passes, junk gives null)
- [x] 1.2 Add 502 and 504 to `RETRYABLE_STATUSES` (api-utils.ts:33), with a retry test
- [x] 1.3 Make the fixture layout: `src/tools/lib/__fixtures__/<provider>/`, the `manifest.json` shape, and a small shared runner for the accept, map, and reject assertions
- [x] 1.4 Write `scripts/refresh-fixtures.ts`: replay the manifest, pull the oracle schemas again, diff, report, and rewrite only under `--write`

## 2. ChEMBL and PubChem

- [x] 2.1 Correct the ChEMBL schemas per the truth map, section B and C
  - `max_phase` as a wire number, and nullable: `pref_name`, `molecule_type`, `standard_units`, mechanism `action_type` and `target_chembl_id`, target `organism`, the `molecule_structures` projection
  - rename `molecular_formula` to `full_molformula`, and delete the dead `drug_indications` field
- [x] 2.2 Rewrite the `drug` action per design D5, and update the description text of the `chembl` tool (chembl.ts:47-49)
  - molecule search for a name query, and the `drug_indication` resource for an indication query
  - no call to `/drug/search.json`
- [x] 2.3 Promote the ChEMBL fixtures with drift twins, and add the table-driven schema tests
- [x] 2.4 Correct the PubChem property schemas: read `ConnectivitySMILES`, replace each maybe-absent `z.unknown()` with a typed `.optional()`, and drop the fabricated row for a nonexistent CID
- [x] 2.5 Rewrite the assay-summary schema and parser: string-array `Column` and `Cell`, selection by the real wire headings, `targetName` from `"Target Accession"`
- [x] 2.6 Rewrite the cross-references source attribution: identifier-pattern registry table, no index zip, `source: null` for an unmatched id
- [x] 2.7 Promote the PubChem fixtures with drift twins, and add the table-driven schema tests

## 3. Clinical group

- [x] 3.1 Correct the DGIdb schema per the SDL: nullable `Gene.name`, nullish `nodes` lists, nullable `interactionTypes[].type` and `gene.name`
- [x] 3.2 ClinicalTrials.gov: remove `filter.phase`, filter phases after the fetch over `designModule.phases`, send `countTotal=true`, and correct the `totalFound` prose of the tool
- [x] 3.3 openFDA: delete the dead REMS fields, and read `spl_medguide` and `patient_medication_information` for the medication-guide signal
- [x] 3.4 EMA: split the medicine list on `;` only
- [x] 3.5 DrugBank: move the client onto the Discovery API, per the secondary-evidence report (truth map, file 07)
  - base `https://api.drugbank.com/discovery/v1`, with `drugs?q=` for the name search and the bonds routes for targets
  - model the Discovery drug record (`drugbank_id`, `name`, `description`, `type`, `groups`), and make `drugbank_id` mandatory
  - delete `drug_interactions` and the dump-shaped fields from the record, because the wire does not serve them
  - use `per_page` (max 50) with the `X-Total-Count` header, because no `limit` parameter exists
  - add the unverified marker with the date and the evidence source
- [x] 3.6 Promote the clinical fixtures with drift twins, and add the table-driven schema tests

## 4. Pharmacology group

- [x] 4.1 IUPHAR: make `complexIds` optional for the list and complexes shapes, keep the subunits read sites guarded, and note the per-shape `type` casing
- [x] 4.2 PharmGKB: move the base to `api.clinpgx.org`, and map the 404 no-results answer to an empty result
- [x] 4.3 STRING: drop the unobserved string branch of `preferredNames`, and correct the comment above it
- [x] 4.4 Promote the pharmacology fixtures with drift twins, and add the table-driven schema tests

## 5. Genetics group

- [x] 5.1 Open Targets: rewrite the expression query to `baselineExpression` with its row schema, and include the first GraphQL error message in the `gqlFetch` failure
- [x] 5.2 GWAS: move the trait search to `findByEfoTrait`, and read `pubmedId` from `study.publicationInfo`
- [x] 5.3 ClinVar: read `variant_type` from `variation_set[]`, and replace `clinsig_uncertain` with `clinsig_vus`
- [x] 5.4 GEO: delete the dead `platform` field, and guard the esummary error record so that no synthetic row is emitted
- [x] 5.5 QuickGO: add `includeFields=goName` to the annotation URL
- [x] 5.6 Ensembl orthologs: resolve the id first, then call `/homology/id/`
- [x] 5.7 Promote the genetics fixtures with drift twins, and add the table-driven schema tests

## 6. Expression and tox group

- [x] 6.1 cBioPortal: delete the dead `mutationCount` field, and read the nested cancer-type id from `id`
- [x] 6.2 KEGG: route the gene pathway membership through `find/genes` plus `link/pathway`
- [x] 6.3 CompTox: apply the confirmed contract from the secondary-evidence report (truth map, file 07)
  - rewrite `GenetoxSchema` onto the summary fields (`ames`, `genetoxCall`, `micronucleus`, `reportsPositive`, `reportsNegative`, `reportsOther`)
  - replace the cancer fields with `cancerCall` and `exposureRoute`, and delete `averageMass` and `probabilityPesticide`
  - make the search-row `dtxsid` nullable, and filter a null row out
  - treat a no-match HTTP 400 with a ProblemDetail body as an expected empty result
  - change the active predicate to `hitc >= 0.9`, with a float output type
  - delete `fetchAssayNames`, or point it at `/bioactivity/assay/search/by-aeid/{aeid}` and read `assayComponentEndpointName`
  - replace the seem `z.union` with a plain array, and keep every other array wrap as it is
- [x] 6.4 DisGeNET: apply the confirmed v1 contract from the secondary-evidence report (truth map, file 07)
  - base `https://api.disgenet.com/api/v1`, route `GET /gda/summary` with query parameters, and `page_number` instead of `limit`
  - the raw key in the `Authorization` header, with no `Bearer` prefix
  - the envelope `{status, payload, paging, httpStatus}`, with the count from `paging.totalElements`
  - the v1 field names (`symbolOfGene`, `geneNcbiID`, `diseaseName`, `diseaseUMLSCUI`, `diseaseType`, `yearInitial`, `yearFinal`, `numPMIDs`)
  - delete `gene_name` and the record-level `source`, and narrow the source enum to the v1 values
  - treat a non-OK `status` with an `error` body as an expected gated outcome, because a free academic key serves curated sources only
- [x] 6.5 Promote the expression and tox fixtures with drift twins, and add the table-driven schema tests

## 7. Research group

- [x] 7.1 Context7: correct the routes and the `title` field, model the real docs shapes, and correct the mock in `misc-tools.test.ts`
- [x] 7.2 Semantic Scholar: let the `externalIds` values be numbers, so that `CorpusId` survives the read
- [x] 7.3 Identifier resolver: delete the dead `proteinFamily` field, and take the nullable `organism` fix from task 2.1
- [x] 7.4 Promote the research fixtures with drift twins, and add the table-driven schema tests

## 8. Cross-cutting

- [x] 8.1 Add the `Logger` report at each silent degradation site (target-identity-filter.ts:87, collectors/index.ts:309, identifier-resolver.ts:251, the per-molecule skips in chembl-client, the IUPHAR catch sites)
- [x] 8.2 Add the keyless live integration blocks under `src/providers/integration/`, gated by `CORTEX_LIVE_API_TESTS`, for these providers: ChEMBL, PubChem, DGIdb, IUPHAR, ClinPGx, QuickGO, GWAS Catalog, Open Targets, ClinicalTrials.gov, Ensembl, KEGG, Context7
- [x] 8.3 Correct the stale testing note in `harness/CLAUDE.md`, and document the fixture tier and the refresh script there
- [x] 8.4 Add the absence-policy comment at the top of each client file

## 9. Verification

- [x] 9.1 Run `tsc -p tsconfig.json` and `bun test` offline, and make sure that both are green with no key set
- [x] 9.2 Run the refresh script without `--write`, and make sure that each manifest replays with no unexplained drift
- [x] 9.3 Run the live tier with `CORTEX_LIVE_API_TESTS=1` for the 12 providers of task 8.2, and make sure that each schema accepts the live payload
- [x] 9.4 Run `bun run format:file` on each changed source file
- [x] 9.5 Do the harness `verify` flow, and make sure that the package boundary is correct
