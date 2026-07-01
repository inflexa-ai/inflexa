# context7-sandbox-integration Specification

## Purpose

Gives every sandbox agent a runtime documentation-lookup capability so it can
verify a package's current API before writing code instead of guessing from
memory — important for the rapidly-evolving bioinformatics stack (scvi-tools,
spatialdata, cellrank, pertpy, muon). The capability is two tools,
`resolveLibraryId` and `queryDocs` (`harness/src/tools/research/context7-docs.ts`),
in the shared base sandbox tool set.

These tools are a **direct HTTP client** to the Context7 REST API at
`https://context7.com/api/v1` (the `/search` and `/docs` endpoints), built with
`defineTool` and the shared `apiFetch` helper. They are NOT an MCP integration
and do NOT wrap any `mcp__…` tool — there is no MCP server, protocol, or proxy in
this path. "Not found" / "no docs" are returned as `{ found: false }` data
variants; an upstream HTTP failure throws and the agent loop surfaces it as an
`is_error` tool result. Usage discipline (when to look up, when the skill
references already suffice) is taught in the shared sandbox orient prompt, not
enforced in code.

## Requirements

### Requirement: Context7 tools available to all sandbox agents

Every sandbox agent SHALL have access to the `resolveLibraryId` and `queryDocs`
tools via the shared base sandbox tool set
(`BASE_SANDBOX_TOOLS` in `harness/src/agents/sandbox/shared.ts`).

#### Scenario: Context7 tools present in the base sandbox tool set

- **WHEN** the base sandbox-agent tool set is inspected
- **THEN** it contains a `resolveLibraryId` tool that resolves a package name to a Context7 library ID
- **AND** it contains a `queryDocs` tool that queries documentation for a resolved library

#### Scenario: Any sandbox agent can look up package docs

- **WHEN** the `single-cell-agent` needs to verify the scanpy API for `rank_genes_groups`
- **THEN** it can call `resolveLibraryId("scanpy", ...)` to get the library ID
- **AND** then call `queryDocs` with that library ID and a query to retrieve current documentation

### Requirement: Context7 tools are a direct HTTP client, not MCP

The `resolveLibraryId` and `queryDocs` tools SHALL call the Context7 REST API
directly over HTTP at `https://context7.com/api/v1` (`resolveLibraryId` → the
`/search` endpoint; `queryDocs` → the `/docs` endpoint). They SHALL be defined
with `defineTool` and SHALL NOT delegate to, wrap, or otherwise depend on any MCP
server or `mcp__…` tool. The on-wire tool ids SHALL be `resolve_library_id` and
`query_docs`.

#### Scenario: resolveLibraryId calls the search endpoint directly

- **WHEN** an agent calls `resolveLibraryId` with a package name like `"scanpy"`
- **THEN** the tool issues an HTTP request to `https://context7.com/api/v1/search`
- **AND** returns the best-matching library ID, or `{ found: false }` when there is no match

#### Scenario: queryDocs calls the docs endpoint directly

- **WHEN** an agent calls `queryDocs` with a library ID and a query
- **THEN** the tool issues an HTTP request to `https://context7.com/api/v1/docs`
- **AND** returns the documentation content, or `{ found: false }` when none is available

#### Scenario: No MCP dependency in the lookup path

- **WHEN** the context7 tool module is inspected
- **THEN** it references neither an MCP client nor any `mcp__…` tool symbol

### Requirement: Context7 usage guidance lives in the shared orient prompt

`sandboxOrientCorePrompt` SHALL include a Context7 section instructing agents
to look up current documentation before writing non-trivial code
(`harness/src/prompts/sandbox-standards.ts`). It names the `resolve_library_id` →
`query_docs` two-step flow, while telling agents not to look up every well-known
function already covered by their skill references.

#### Scenario: Agent looks up docs when uncertain

- **WHEN** a sandbox agent is about to use a package function it is not confident about
- **THEN** the prompt directs it to call `resolveLibraryId` then `queryDocs` to verify the signature first

#### Scenario: Agent does not over-use lookups

- **WHEN** a sandbox agent uses a well-documented function covered in its skill references
- **THEN** the prompt indicates a context7 lookup is unnecessary — the skill reference suffices
