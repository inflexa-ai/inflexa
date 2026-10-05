# apiFetch names the harness, and an AlphaFold refusal is an error

## Why

On 16 September 2026, a chat on staging called `alphafold_prediction` four
times. The accessions were P05089, P14780, P80511, and P38398. Each call
returned `found: false`, but AlphaFold DB holds a model for each accession.
P38398 is the fixture of the tool.

AlphaFold DB answers 403 when the User-Agent is `node`, `undici`,
`Bun/<version>`, or empty. It answers 200 for a descriptive value, for example
`curl/8.5.0` or `inflexa-harness`. `apiFetch` sends no User-Agent, thus the
runtime sends its default value.

`isUnexpectedApiError` reads each 4xx as an expected absence. Thus the
AlphaFold client changed the 403 into `null`, and the tool returned
`found: false`. The tool description tells the agent to report that absence
and not to retry. As a result, the agent told the user that the models did
not exist.

QuickGO, ChEMBL, the GWAS Catalog, and IMPC answer 200 to the `node` value.
Thus only AlphaFold DB refuses the default value today.

## What Changes

- `apiFetch` sends `User-Agent: inflexa-harness (+https://inflexa.ai)` on
  each request. A User-Agent in the `headers` option of the caller wins, in
  any letter case.
- The AlphaFold client gives `null` for 400 and 404 only. Each other failure
  throws, a different 4xx included. Thus a 403 becomes an error tool result.
- Three tests pin the new behavior: the default header, the header of the
  caller, and the AlphaFold 403.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-tools`: a new requirement, "The shared HTTP helper names the
  harness", gives the User-Agent rule of `apiFetch`.
- `alphafold-tools`: the requirement "AlphaFold DB structure prediction tool"
  names 400 and 404 as the only absence, and it gets a scenario for a 403. At
  the sync, the purpose text that says each 4xx is expected gets the same
  rule.

## Impact

- `harness/src/tools/lib/api-utils.ts`: a new exported constant
  `HARNESS_USER_AGENT`, and the header merge in `runFetch`.
- `harness/src/tools/lib/alphafold-client.ts`: the error branch of
  `fetchAlphaFoldPrediction`.
- 29 source files call `apiFetch` or `apiFetchValidated`. Each of their
  requests now carries the new User-Agent. No caller sets one today.
- `isUnexpectedApiError` does not change. The other ten call sites keep the
  rule that each 4xx is expected.
- `api-utils` is not in `harness/src/index.ts`. No embedder sees the change.
- No new dependency.
