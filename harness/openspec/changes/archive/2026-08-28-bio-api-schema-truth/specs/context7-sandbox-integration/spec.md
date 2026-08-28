# context7-sandbox-integration Delta

## MODIFIED Requirements

### Requirement: Context7 tools are a direct HTTP client, not MCP

The `resolveLibraryId` and `queryDocs` tools MUST call the Context7 REST API directly over HTTP at `https://context7.com/api/v1`. `resolveLibraryId` calls the `/search` endpoint. `queryDocs` calls the library path itself: `GET /api/v1/{owner}/{lib}?type=json`, with the query in the `topic` parameter, because a `/docs` endpoint does not exist on the API. The tools MUST be defined with `defineTool` and MUST NOT delegate to, wrap, or otherwise depend on any MCP server or `mcp__…` tool. The on-wire tool ids MUST be `resolve_library_id` and `query_docs`.

The search response names a library with the wire field `title`. The docs response is `{snippets: [...]}`, and the tool renders the snippets as text.

#### Scenario: resolveLibraryId calls the search endpoint directly

- **WHEN** an agent calls `resolveLibraryId` with a package name like `"scanpy"`
- **THEN** the tool issues an HTTP request to `https://context7.com/api/v1/search`
- **AND** returns the best-matching library ID from the `title`-bearing results, or `{ found: false }` when there is no match

#### Scenario: queryDocs calls the library path directly

- **WHEN** an agent calls `queryDocs` with a library ID and a query
- **THEN** the tool issues an HTTP request to `https://context7.com/api/v1/{owner}/{lib}?type=json` with the query as `topic`
- **AND** returns the snippet content as text, or `{ found: false }` when the library is not found (404)

#### Scenario: No MCP dependency in the lookup path

- **WHEN** the context7 tool module is inspected
- **THEN** it references neither an MCP client nor any `mcp__…` tool symbol
