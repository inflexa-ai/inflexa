## Why

The agents cannot search the drug authorizations of the FDA and the EMA, and they cannot search patents. No harness tool covers these two sources. The API of Amass Technologies gives both sources, and a user can supply an Amass API key.

## What Changes

- A new client in `src/tools/lib/` reads the Amass API (`https://api.amass.tech/api/v1`). It sends the key as a Bearer token, and it reads the error envelope of Amass. It uses `apiFetch`, thus it obeys `Retry-After` on a 429 response.
- A new tool `search_regulatory_approvals` reads Amass RegulatoryCore, the FDA and EMA authorizations. It has three actions:
  - `search` finds authorizations by a query, the agency, the status, the orphan designation, the designations, and the authorization dates. Each result carries the label sections that match the query.
  - `details` gives one authorization and the table of contents of its source documents. It takes an Amass ID, an FDA application number, an EMA product number, an NDC, or an SPL Set ID.
  - `section` gives the full text of one document section from an FDA label, an FDA review, an EMA SmPC, or an EMA EPAR.
- A new tool `search_patents` reads Amass PatentCore. It has two actions:
  - `search` finds patents by a query, the assignee, the inventor, the CPC code, the country, and the dates. A result carries no claims and no description.
  - `details` gives one patent. It takes an Amass ID, a publication number, or an application number. It gives the claims and the description only when the caller asks for them.
- Each tool resolves an external identifier to the Amass ID itself. Thus the agent does not call a lookup first.
- The key is optional. `BioToolKeys` gets an optional `amass` field. The two tools obey the pattern of `comptox`:
  - The harness registers each tool when the key is empty.
  - A call with no key throws an error that names `AMASS_API_KEY` and the page where a user gets a key.
  - The tool description tells the agent: do not call again, tell the user, and continue without the Amass data.
- The conversation agent gets both tools. The drug-repurposing agent gets `search_regulatory_approvals` through its allowlist. Its prompt tells it when to use the tool.
- The response schemas mirror the published OpenAPI document of Amass. A response field that the document gives as an enum is a plain string. That document marks PatentCore as a preview, thus the patent schema stays strict.
- The other four cores of Amass stay out of scope, because current tools cover them. The `changes` feeds and the `credits` endpoint also stay out of scope.

## Capabilities

### New Capabilities

- `amass-tools`: the Amass client, the two tools and their actions, the key contract, and the agents that get each tool.

### Modified Capabilities

None. No current requirement lists the fields of `BioToolKeys` or the tools of the drug-repurposing agent.

## Impact

- Harness source:
  - a new client and its configuration in `src/tools/lib/`
  - the two tools in `src/tools/bio/`
  - `src/tools/bio/keys.ts`
  - `src/agents/conversation-agent.ts`
  - the sandbox registry and the `SandboxToolName` union in `src/agents/sandbox/`
  - `src/agents/sandbox/drug-repurposing-agent.ts` and `src/prompts/sandbox/drug-repurposing-agent.ts`
- The public API: `BioToolKeys` gets the optional `amass` field. The change is additive, thus an embedder compiles with no change.
- The CLI: a separate change in `cli/` adds `bioKeys.amass` to the configuration. That change comes after the harness publish and the pin bump.
- Each call spends the credits of the user. Amass lets a user send 60 requests in 60 seconds. The tools ask for no approval, the same as the other tools with a key.
- The golden fixtures come from real Amass responses. Thus a fixture refresh uses a real key. The unit tests use a fake key and no key.
