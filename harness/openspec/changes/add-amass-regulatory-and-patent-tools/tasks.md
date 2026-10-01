## 1. The key and the client

- [x] 1.1 Add the optional `amass` field to `BioToolKeys` in `src/tools/bio/keys.ts`.
- [x] 1.2 Add `src/tools/lib/amass-config.ts` with the base URL and `getAmassHeaders(apiKey)`. The function throws with `AMASS_API_KEY` and the key page when the key is empty.
- [x] 1.3 Add the zod schemas to `src/tools/lib/amass-client.ts` from the OpenAPI document: the RegulatoryCore search, get, section, and lookup, the PatentCore search, get, and lookup, and the error envelope.
- [x] 1.4 Write the file-top comment of the client with the absence policy of Amass.
- [x] 1.5 Add the client functions for each endpoint of 1.3 through `apiFetchValidated`, with the Bearer header.
- [x] 1.6 Map each Amass status to one outcome, as the requirement "Each Amass status maps to one outcome" gives. Do not use `isUnexpectedApiError`.
- [x] 1.7 Add the identifier changes: a bare FDA application number goes as the `NDA`, `BLA`, and `ANDA` forms in one lookup, and a package NDC loses its third segment.

## 2. The tools

- [x] 2.1 Add `createSearchRegulatoryApprovalsTool({ apiKey })` in `src/tools/bio/search-regulatory-approvals.ts` with the actions `search`, `details`, and `section`.
- [x] 2.2 Make the regulatory results compact: the groups by source document, a maximum of 5 matched sections for each record, and the count of all matched sections.
- [x] 2.3 Add `createSearchPatentsTool({ apiKey })` in `src/tools/bio/search-patents.ts` with the actions `search` and `details`, and the flags `includeClaims` and `includeDescription`.
- [x] 2.4 Write the description of each tool: the source, the accepted identifiers, the `status` values, and the key contract of comptox.
- [x] 2.5 Add `createAmassTools(keys)` to `src/tools/bio/keys.ts`. It gives `keys.amass ?? ""` to each factory.
- [x] 2.6 Export the two tool modules from `src/tools/bio/index.ts`.

## 3. The agents

- [x] 3.1 Add the two tools to the tool list of `src/agents/conversation-agent.ts`.
- [x] 3.2 Add `searchRegulatoryApprovals` to `SandboxToolName` in `src/agents/sandbox/types.ts`, and map it in the registry of `src/agents/sandbox/shared.ts`.
- [x] 3.3 Add `searchRegulatoryApprovals` to `meta.tools` in `src/agents/sandbox/drug-repurposing-agent.ts`.
- [x] 3.4 Add the use of `search_regulatory_approvals` to `src/prompts/sandbox/drug-repurposing-agent.ts`: the authorization status, the approved indications, the designations, and the safety sections of the label.

## 4. Fixtures and tests

- [x] 4.1 Put the live payloads of 2026-09-30 under `src/tools/lib/__fixtures__/amass/`, with a `manifest.json`: the regulatory search, get, section, and lookup, and the 404 envelope.
- [x] 4.2 Capture the PatentCore get and lookup, and one EMA get, with the key. The three calls cost 3 credits.
- [x] 4.3 Add a `*.drift.json` twin for each schema. The live patent lookup holds an application number with two IDs, thus no synthetic fixture is necessary.
- [x] 4.4 Add `src/tools/lib/amass-client.fixtures.test.ts` through `fixture-runner.ts`.
- [x] 4.5 Add stubbed-fetch unit tests for each tool, with a fake key and with no key. Cover each scenario of `specs/amass-tools/spec.md`.
- [x] 4.6 Add `src/providers/integration/amass.integration.test.ts` inside `describe.skipIf(!process.env.AMASS_API_KEY)`.
- [x] 4.7 Update each current test that counts the tools of an agent.

## 5. Verification

- [x] 5.1 Run `bun run format:file` on each changed file in `src/`.
- [x] 5.2 Run `tsc -p tsconfig.json` and `bun test`, and make sure that both pass.
- [x] 5.3 Run the Amass integration test one time with the key.
