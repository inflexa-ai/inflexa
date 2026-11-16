# Research: an MCP client in the harness, for MCP servers that the user adds

> This document is research for a GitHub issue and for an OpenSpec change. It
> gives the facts. It is not a design.
>
> Sources: the MCP specification, revision `2026-07-28`
> (`modelcontextprotocol/modelcontextprotocol` at `0b22bfe`), the TypeScript SDK
> `modelcontextprotocol/typescript-sdk` at `919bb8e` (npm
> `@modelcontextprotocol/client` `2.4.0`) and its `v1.x` branch at `3b73021`
> (npm `@modelcontextprotocol/sdk` `1.32.2`), the first-party documents of Claude
> Code, VS Code, Cursor, OpenCode, Codex, the AI SDK, and DBOS, and inflexa
> `main` at `2722f88`. Researched 2026-11-12.

## 1. The questions and the answers

1. **Transports.** The specification has two standard transports: stdio for a
   local child process, and Streamable HTTP for a server that runs as an
   independent process. HTTP+SSE is deprecated. OAuth applies only to the HTTP
   transport. A stdio client gets its credentials from the environment. Section 3
   gives the facts.
2. **The client lifecycle.** The current revision has no `initialize` handshake
   and no session. The SDK `Client` still has `connect()`, and it speaks both
   protocol eras. Section 4 gives the facts.
3. **The tool result.** A result has a `content` array, an optional
   `structuredContent` value, and an `isError` flag. Clients put a limit on the
   size. Section 5 gives the facts.
4. **The annotations.** The annotations are hints. The specification tells a
   client not to trust them from an untrusted server. Clients use them for
   approval modes and to send a call again. Section 6 gives the facts.
5. **The names.** Clients add a prefix with the server name. The Anthropic API
   accepts 128 characters and no dot. Section 7 gives the facts.
6. **The configuration files.** All clients use `command`, `args`, `env`, `url`,
   and `headers`. The variable syntax is different in each client. Section 8
   gives the facts.
7. **Bun and Zod.** The SDK v2 claims Bun support, and its CI runs a Bun test
   for HTTP only. The SDK v2 depends on Zod 4. Section 9 gives the facts.
8. **Durability.** The specification has no idempotency key and no replay
   guarantee. A DBOS step that stops before its checkpoint runs again. Section
   10 gives the facts.

## 2. The current revision changed the protocol

The revision `2026-07-28` is the current revision
(`https://modelcontextprotocol.io/specification/latest` redirects to it). It
makes MCP stateless. The changes that affect a client:

- **No handshake.** The revision removes `initialize` and
  `notifications/initialized`. Each request carries the protocol version and the
  client capabilities in `_meta` (changelog, major change 2).
- **No session.** The revision removes `Mcp-Session-Id`. `tools/list` "no longer
  vary per-connection" (changelog, major change 1).
- **A discovery call.** A server must give a `server/discover` method. A client can
  call it first (changelog, major change 3).
- **No server requests.** A server does not send a JSON-RPC request to the
  client. To get input, a server returns an `InputRequiredResult`, and the
  client sends the original request again with `inputResponses`. This is the
  Multi Round-Trip Requests (MRTR) pattern (changelog, major change 7).
- **A new result field.** Each result has `resultType`, `"complete"` or
  `"input_required"` (changelog, major change 8).
- **Change notifications on a stream.** A client opens `subscriptions/listen` to
  get `notifications/tools/list_changed` (changelog, major change 4).
- **Deprecated features.** Roots, Sampling, and Logging are deprecated
  (changelog, "Deprecated", item 1).

The SDK names the two families "eras". The `legacy` era is each revision from
`2024-10-07` to `2025-11-25`. The `modern` era starts at `2026-07-28`
(`docs/protocol-versions.md`, "Name the two eras"). A modern-only client
"Fails" against a legacy server. A dual-era client works against both
(`basic/versioning.mdx`, "Compatibility Matrix").

Most servers that a user can
install today are legacy servers. This is an inference from the date of the
revision, not a measured fact.

## 3. Transports, and local against remote

### 3.1 stdio

"the client launches the MCP server as a subprocess" (`basic/transports/stdio`).

- **Framing.** One JSON-RPC message on each line of `stdin` and `stdout`. The
  server must not write other text to `stdout`.
- **Logs.** The server can write to `stderr`. The client "SHOULD NOT assume
  `stderr` output indicates error conditions".
- **Cancel.** The client sends `notifications/cancelled` with the request ID.
- **Shutdown.** Close `stdin`, wait, then send `SIGTERM`, then `SIGKILL`.
- **A crash.** "the client SHOULD restart it". The in-flight requests "are
  simply lost and the client can retry them against the fresh process".
- **The era probe.** A dual-era client sends `server/discover` first. Any error
  other than a recognized modern error, or no answer, identifies a legacy server.

### 3.2 Streamable HTTP

"the server operates as an independent process that can handle multiple client
connections" (`basic/transports/streamable-http`).

- **Requests.** Each JSON-RPC message is one HTTP POST to one endpoint. The
  server replies with one JSON object or with an SSE stream for that request.
- **Headers.** Each POST carries `MCP-Protocol-Version`, `Mcp-Method`, and, for
  `tools/call`, `Mcp-Name`.
- **Cancel.** The client closes the response stream. A broken stream loses the
  request. The revision removes `Last-Event-ID` resumption (changelog, major
  change 9).
- **Local servers.** A local server "SHOULD bind only to localhost", and it must
  validate `Origin` against DNS rebinding.

### 3.3 HTTP+SSE

HTTP+SSE is the transport of `2024-11-05`. The current revision lists it as
Deprecated, with a minimum window of twelve months (changelog, "Deprecated",
item 2). The SDK keeps `SSEClientTransport` as a fallback
(`docs/clients/connect.md`). Claude Code tries HTTP first and changes to SSE
automatically from v2.1.265 (Claude Code MCP docs, "Option 2").

### 3.4 The difference between a local and a remote server

The specification does not define a "local server" type. The difference comes
from the transport:

| Property | stdio | Streamable HTTP |
| --- | --- | --- |
| Who starts the server | The client, as a child process | The server operator |
| How many clients | One | Many |
| Credentials | From the environment | OAuth 2.1, or a header |
| Cancel | `notifications/cancelled` | Close the stream |

A local server can also use HTTP on `localhost`. The AI SDK documents say: "The
stdio transport should only be used for local servers", and recommend HTTP for
production.

### 3.5 Authorization

Authorization is OPTIONAL (`basic/authorization`):

> Implementations using an STDIO transport **SHOULD NOT** follow this
> specification, and instead retrieve credentials from the environment.

For HTTP, the client is an OAuth 2.1 client. The server must publish OAuth 2.0
Protected Resource Metadata (RFC 9728). The client uses PKCE, sends the
`resource` parameter (RFC 8707), and must validate the `iss` value. Client ID
Metadata Documents replace Dynamic Client Registration, which is now deprecated
(changelog, "Deprecated", item 4).

A client that supports only stdio servers and HTTP servers with a static header
does not use the OAuth flow. Claude Code, VS Code, and Codex all accept a
static `Authorization` header as an alternative to OAuth (section 8).

The security guide adds a rule for local servers. Before a client starts a new
local server from a one-click configuration, the client "MUST" show "the exact
command that will be executed, without truncation"
(`docs/2026-07-28/tutorials/security/security_best_practices`, "Local MCP Server
Compromise"). The Claude Desktop guide says that a local server "runs with your
user account permissions".

## 4. The client lifecycle in the TypeScript SDK

### 4.1 Connect and the era

| Step | API | Fact |
| --- | --- | --- |
| Make | `new Client({ name, version }, options)` | `docs/clients/connect.md` |
| Connect | `await client.connect(transport)` | The default mode runs the legacy `initialize` handshake |
| Select the era | `versionNegotiation: { mode: 'legacy' \| 'auto' \| { pin } }` | `'auto'` probes with `server/discover` and falls back to `initialize` |
| Skip the probe | `connect(transport, { prior })` | `prior` takes a stored `DiscoverResult`, or `{ kind: 'legacy' }` |
| Read the server | `getServerCapabilities()`, `getServerVersion()`, `getInstructions()`, `getProtocolEra()` | Each gives `undefined` before `connect()` resolves |

On stdio, the `'auto'` probe runs on "a short-lived sibling process", because
some servers exit on a request before `initialize`. The SDK says: "Do not
default a spawn-per-invocation CLI tool to `'auto'`", because a silent legacy
server stalls `connect()` for the probe timeout (`docs/protocol-versions.md`).
The specification lets a client store the era for "the lifetime of the server
process (stdio)", and also across restarts of the same configuration
(`basic/versioning.mdx`).

### 4.2 Tools

- **`listTools()`** follows each `nextCursor` and returns one list.
  `listMaxPages` (default 64) stops a list that does not end
  (`docs/clients/calling.md`).
- **`callTool({ name, arguments }, options)`** returns the result. "A failed
  tool call is still a result: check `isError`". Only protocol failures, for
  example an unknown tool or a timeout, throw (`docs/clients/calling.md`).
- **Output validation.** If an earlier `listTools()` gave an `outputSchema`,
  `callTool` validates `structuredContent` and rejects a result that does not
  match.
- **Input required.** In the modern era, a `tools/call` can return
  `resultType: "input_required"`. The SDK has an automatic driver for these
  requests, and a manual mode (`RequestOptions`,
  `packages/core-internal/src/shared/protocol.ts:117-160`).

### 4.3 Timeouts and cancel

`RequestOptions` (`protocol.ts:117-160`):

- **`timeout`.** The default is `DEFAULT_REQUEST_TIMEOUT_MSEC = 60_000`
  (`protocol.ts:112`). A timeout raises `SdkError` with code `REQUEST_TIMEOUT`.
- **`signal`.** An `AbortSignal`. An abort raises an `AbortError`. On abort or
  timeout, the SDK sends `notifications/cancelled` where the transport needs it
  (`protocol.ts:1520-1540`).
- **`resetTimeoutOnProgress` and `maxTotalTimeout`.** A progress notification
  can reset the timer. `maxTotalTimeout` is the absolute limit.

The specification says that a client "SHOULD" set a timeout on each request,
and "SHOULD always enforce a maximum timeout" (`basic/patterns/cancellation`).

### 4.4 List changes

- **The specification.** A server sends `notifications/tools/list_changed` only
  on an open `subscriptions/listen` stream (`server/tools`, "List Changed
  Notification").
- **The SDK.** `ClientOptions.listChanged` refreshes the lists automatically,
  with `autoRefresh` and `debounceMs`. On a modern connection, the SDK opens the
  stream itself (`packages/client/src/client/client.ts:289`, `:588`, `:2627-2665`).
- **Claude Code.** It refreshes the list in an interactive session. With `-p`
  and in the Agent SDK, it refreshes only the tool list. If a refresh fails, it
  keeps the earlier list (Claude Code MCP docs, "Dynamic tool updates").

### 4.5 Close

`close()` closes the transport and rejects each request in flight with
`CONNECTION_CLOSED`. For stdio, it closes `stdin`, then sends `SIGTERM`, then
`SIGKILL` (`docs/clients/connect.md`).

### 4.6 One process for each boot, or one for each run

The specification does not set a lifetime. The clients do this:

- **Claude Code.** It connects the servers when a session starts. `MCP_TIMEOUT`
  sets the startup timeout. In `-p` mode, it starts a stdio server again on the
  next call after the process exits (Claude Code MCP docs, "Stdio servers that
  exit or fail to start").
- **Codex.** `startup_timeout_sec` (default 10 seconds) and a `required` flag
  for each server (Codex MCP docs).
- **OpenCode.** It has separate `startup`, `catalog`, and `execution` timeouts:
  30 seconds, 30 seconds, and 12 hours (OpenCode MCP docs).
- **The AI SDK.** It gives two patterns. A short-lived client closes when the
  response ends. A long-lived client stays open until the application stops
  (AI SDK MCP docs).

## 5. The tool result

### 5.1 The shape

A `CallToolResult` has these fields (`server/tools`, "Tool Result"):

- **`content`.** An array of blocks: `text`, `image` (`data` in base64 and
  `mimeType`), `audio`, `resource_link` (a URI), and `resource` (an embedded
  resource with `text` or a base64 `blob`). Each block can have `annotations`
  with `audience` and `priority`.
- **`structuredContent`.** Any JSON value. If the tool has an `outputSchema`, the
  value must obey it. "a tool that returns structured content SHOULD also return
  the serialized JSON in a TextContent block."
- **`isError`.** `true` marks a tool execution error. Clients "SHOULD provide
  tool execution errors to language models to enable self-correction". A
  protocol error, for example an unknown tool, is a JSON-RPC error.

### 5.2 How the harness shape compares

- **The ok value.** A harness ok value goes to the model as JSON, or as an
  excerpt over `TOOL_RESULT_CAP = 32 * 1024`
  (`harness/src/loop/tool-output.ts:14`, `harness/src/loop/tool-adapter.ts:162-182`).
- **Pictures.** A harness tool attaches a picture with `withToolResultImage`,
  and the loop sends it as a file part (`harness/src/tools/define-tool.ts`,
  `toolResultImageKey`). An MCP `image` block has the same data: base64 and a
  media type.
- **Errors.** `isError: true` maps to the error channel of the harness. A
  `ToolError` has `error` and `retryable`
  (`harness/src/tools/define-tool.ts`, `ToolError`).
- **Other blocks.** The harness has no equivalent for `audio`, `resource_link`,
  or an embedded `blob`.

### 5.3 Size conventions in clients

- **Claude Code.** It shows a warning over 10,000 tokens. The default limit is
  25,000 tokens, and `MAX_MCP_OUTPUT_TOKENS` changes it. A text result over
  50,000 characters goes to a file, and the model gets the path. A tool can raise
  its own limit with `_meta["anthropic/maxResultSizeChars"]`, up to 500,000. An
  error text over about 11,000 characters keeps the first 5,000 and the last
  5,000. An HTTP response over 16 MiB fails (Claude Code MCP docs, "MCP output
  limits and warnings").
- **Codex.** It has `tools.<tool>.output_token_limit` for each tool (Codex MCP
  docs).
- **Cursor.** It attaches a returned image to the chat (Cursor MCP docs).

## 6. Annotations and approval

### 6.1 The annotations

`ToolAnnotations` (`schema/2026-07-28/schema.ts:1900-1950`):

| Hint | Meaning | Default |
| --- | --- | --- |
| `readOnlyHint` | "the tool does not modify its environment" | `false` |
| `destructiveHint` | "the tool may perform destructive updates" | `true` |
| `idempotentHint` | "calling the tool repeatedly with the same arguments will have no additional effect" | `false` |
| `openWorldHint` | "this tool may interact with an 'open world' of external entities" | `true` |

`destructiveHint` and `idempotentHint` have a meaning only when `readOnlyHint` is
`false`. The schema says: "Clients should never make tool use decisions based on
`ToolAnnotations` received from untrusted servers." The tools page says that a
client "MUST consider tool annotations to be untrusted unless they come from
trusted servers".

The specification also says: "there SHOULD always be a human in the loop with
the ability to deny tool invocations." A client "SHOULD" show the tool input to
the user before the call (`server/tools`, "Security Considerations").

### 6.2 What clients do

- **Claude Code.** Permission rules use `mcp__<server>__<tool>` or
  `mcp__<server>__*`. An auto-approval glob must start with a literal server name
  (permissions docs, "MCP"). `readOnlyHint` lets read-only calls run in parallel.
  `readOnlyHint` or `idempotentHint` lets Claude Code send a call again one time
  after a connection closes. `_meta["anthropic/requiresUserInteraction"]: true`
  forces a prompt on each call (Claude Code MCP docs).
- **Codex.** `default_tools_approval_mode` takes `auto`, `prompt`, `writes`, or
  `approve`. "The `writes` mode prompts for tools that aren't marked read-only."
  `tools.<tool>.approval_mode` overrides the server value (Codex MCP docs).
- **Cursor.** "Cursor asks for approval before using MCP tools by default." An
  allowlist lets a tool run without a prompt in Auto-review mode (Cursor MCP
  docs).
- **OpenCode.** Permission rules match the tool name, for example `context7_*`
  (OpenCode MCP docs).
- **VS Code.** The `tools` field selects the tools to expose. "This doesn't
  bypass tool approvals" (VS Code MCP configuration reference).

### 6.3 The approval in the harness

A harness tool has an `approval` hook that runs before `execute`
(`harness/src/tools/define-tool.ts:210`, `:324`). The reply can be `once`,
`always`, or `reject`, and `grantKey` sets the key of an `always` grant
(`harness/src/tools/approval/contract.ts:19-39`). This matches the per-tool and
per-server allowlists of the clients above.

## 7. Names

### 7.1 The specification

A tool name "SHOULD" have 1 to 128 characters from `A-Z`, `a-z`, `0-9`, `_`,
`-`, and `.`. A name is unique only in one server. A client that aggregates
servers "SHOULD implement a disambiguation strategy such as prefixing tool names
with a server identifier". The `serverInfo` name "SHOULD NOT be relied upon for
disambiguation" (`server/tools`, "Tool Names").

### 7.2 The model providers

- **Anthropic.** `name` must match `^[a-zA-Z0-9_-]{1,128}$` (Claude API, "Define
  tools"). Thus a dot in an MCP tool name is not permitted. A `tool_use.name` in
  the history accepts 200 characters (Claude Code errors docs).
- **OpenAI.** The Chat Completions `FunctionObject.name` "Must be a-z, A-Z, 0-9,
  or contain underscores and dashes, with a maximum length of 64"
  (`openai/openai-openapi`, branch `manual_spec`, commit `498c71d`,
  2025-04-29). The Responses `FunctionTool.name` in the same file states no
  limit.

### 7.3 The clients

| Client | Full name | Characters |
| --- | --- | --- |
| Claude Code | `mcp__<server>__<tool>` | `.` and spaces become `_` in the server segment. A name over 128 characters is not sent |
| Claude Code, plugin | `mcp__plugin_<plugin>_<server>__<tool>` | Each character outside `A-Za-z0-9_-` becomes `_` |
| OpenCode | `<server>_<tool>` | Each character outside letters, digits, `_`, and `-` becomes `_` |

Sources: Claude Code MCP docs ("Tools with names longer than 128 characters",
plugin section) and permissions docs ("MCP"), OpenCode MCP docs.

With the double underscore, a server name that contains `__` is ambiguous. Claude
Code documents this case for a server named `reports__v2` (permissions docs).
Harness tool IDs are snake_case, for example `web_search` and `web_fetch`. Thus a
prefix such as `mcp__` keeps MCP tools apart from them.

## 8. Configuration files

| Client | File | Root key | stdio fields | HTTP fields | Variables |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `.mcp.json`, `~/.claude.json` | `mcpServers` | `command`, `args`, `env` | `type`, `url`, `headers`, `headersHelper`, `timeout` | `${VAR}`, `${VAR:-default}` in `command`, `args`, `env`, `url`, `headers` |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers` | `command`, `args`, `env` | — | — |
| VS Code, portable | `.mcp.json`, `mcp-config.json` | `mcpServers` | `type`, `command`, `args`, `env`, `cwd`, `tools` | `type`, `url`, `headers`, `oauthClientId`, `tools` | `${NAME}`, `${NAME:-default}` |
| VS Code, editor format | `.vscode/mcp.json` | `servers`, `inputs` | `type`, `command`, `args`, `env`, `envFile`, `cwd` | `type`, `url`, `headers`, `oauth` | `${input:id}`, `${env:NAME}`, `${workspaceFolder}` |
| Cursor | `.cursor/mcp.json`, `~/.cursor/mcp.json` | `mcpServers` | `type`, `command`, `args`, `env`, `envFile` | `url`, `headers` | `${env:NAME}`, `${userHome}`, `${workspaceFolder}` |
| OpenCode | `opencode.json` | `mcp` | `type: "local"`, `command` (an array), `environment` | `type: "remote"`, `url`, `headers`, `oauth` | `{env:NAME}` |
| Codex | `config.toml` | `[mcp_servers.<name>]` | `command`, `args`, `env`, `env_vars`, `cwd` | `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers` | Key references by name, for example `bearer_token_env_var` |

Facts about the fields:

- **The `type` field.** In Claude Code, an entry with no `type` is a stdio
  server, and a `url` without `type` is an error. `streamable-http` is an alias
  for `http` (Claude Code MCP docs, "Option 1").
- **Unset variables.** In Claude Code, an unset `${VAR}` with no default stays as
  literal text, with a warning (Claude Code MCP docs, "Environment variable
  expansion").
- **Credential variables.** Claude Code reads some credential variables as empty
  in the `url` and `headers` of a remote server. This stops a project file from
  sending the credentials of the user to a server that it names.
- **Secrets in files.** VS Code says: "Do not commit tokens, passwords, or
  populated authentication headers", and a personal configuration file is not a
  secret store (VS Code MCP configuration reference).
- **Key references.** Codex stores the name of an environment variable, not the
  key (`bearer_token_env_var`, `env_http_headers`, `env_vars`).
- **The child environment.** The SDK `StdioClientTransport` does not pass the
  full parent environment. It passes `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`,
  and `USER` on POSIX, then the configured `env`
  (`packages/client/src/client/stdio.ts:54-99`, `:136-145`). The default `stderr`
  is `"inherit"` (`stdio.ts:29-33`).

## 9. The SDK packages, Bun, and Zod

### 9.1 The packages

| Package | Version | Protocol | Zod | Other dependencies |
| --- | --- | --- | --- | --- |
| `@modelcontextprotocol/client` (v2) | `2.4.0` | Both eras, to `2026-07-28` | `^4.2.0`, a dependency | `@modelcontextprotocol/core`, `cross-spawn`, `eventsource`, `eventsource-parser`, `jose`, `pkce-challenge` |
| `@modelcontextprotocol/sdk` (v1) | `1.32.2` | To `2025-11-25` | `^3.25 \|\| ^4.0`, a dependency and a peer | Also `express`, `hono`, `@hono/node-server`, `cors`, `ajv`, `raw-body`, and others |
| `@ai-sdk/mcp` | `2.0.97` | Both eras | `^3.25.76 \|\| ^4.1.8`, a peer | `@ai-sdk/provider`, `@ai-sdk/provider-utils`, `cross-spawn`, `pkce-challenge` |

Sources: `npm view` on 2026-11-12. The v1 protocol list is in
`src/types.ts:4-6` on the `v1.x` branch. v2 was released 2026-07-27. v1 gets
fixes "for at least six months after the v2 release" (SDK `README.md`).

- **Package size.** The v1 package bundles server dependencies. A client-only
  use of v1 installs `express` and `hono`. The v2 `client` package has no server
  framework.
- **Zod.** Inflexa uses `zod` `^4.4.3` (`harness/package.json:105`). It is in the
  range of each package above.
- **Zod copies.** SDK issue #2011 (open) reports that the v1 package declares
  `zod` as both a dependency and a peer. With Bun, this can install a second
  `zod` copy, and TypeScript then rejects the schema types.
- **The AI SDK client.** `@ai-sdk/mcp` pins `@ai-sdk/provider-utils` `5.0.79`.
  The harness has `5.0.69` installed with `ai` `7.0.154`. `createMCPClient`
  "does not support all features of the full MCP client". The AI SDK docs list
  automatic session persistence, resumable streams, and receiving notifications
  (AI SDK MCP docs).

### 9.2 Bun

- **The claim.** The SDK v2 README says that the SDK "runs on Node.js, Bun, and
  Deno". Issue #1269 ("Non-Node environment support (Bun, Deno, React Native)")
  closed 2026-03-16 as part of v2.
- **The CI.** The SDK CI runs a Bun integration test
  (`.github/workflows/main.yml:95-120`). The test file
  `test/integration/test/server/bun.test.ts` connects a client and a server over
  Streamable HTTP in one process. It does not spawn a stdio child. The unit and
  e2e test matrix is Node.js 20, 22, and 24 only (`main.yml:36-68`).
- **The spawn.** `StdioClientTransport` uses `cross-spawn` on `node:child_process`
  (`stdio.ts:8`, `:136`). The `./stdio` subpath is the only entry that imports a
  process API (`docs/get-started/packages.md`).
- **Old issues.** Issues #91 (a Bun `StdioServerTransport`) and #709 (a
  `bun build --compile` resolve error for a v1 subpath) are closed. Both are about
  v1.
- **Inflexa.** The harness runs on Node.js, and Bun runs only its tests
  (`harness/CLAUDE.md:97`). The CLI release is a `bun build --compile` binary
  (`cli/scripts/build.ts:1-2`). Thus the MCP client runs inside the Bun binary
  when the CLI embeds the harness.

### 9.3 The stdio spike from a compiled Bun binary

On 2026-11-16, a spike did a test of `@modelcontextprotocol/client` `2.4.0`
inside a `bun build --compile` binary (Bun `1.4.4`, macOS). The server was a
`@modelcontextprotocol/server` `2.4.0` stdio server that Node.js `24.22.1` ran.

- **Connect.** The client started the child, connected, and listed the tools in
  51 ms. The negotiated protocol was `2025-11-25`, the default handshake era.
- **A call.** A call of the tool `echo.upper` returned its text block.
- **An error.** A call of a tool that returns `isError: true` gave the result
  with `isError: true` and its text. The client did not throw.
- **A name.** The server accepted the tool name `echo.upper`. Thus a client must
  replace the dot before the name goes to a model provider (refer to section 7).

The spike did not start a third-party server through `npx`. The result: the
stdio transport of SDK v2 works from the compiled CLI binary.

## 10. Durability

### 10.1 The specification

The specification has no idempotency key and no exactly-once rule for
`tools/call`. These facts apply when a client sends a call again:

- **The hint.** `idempotentHint` is the only signal, and it is a hint from the
  server (section 6.1).
- **stdio.** After a crash, the requests "are simply lost and the client can
  retry them against the fresh process" (`basic/transports/stdio`).
- **HTTP.** "A broken response stream loses the in-flight request; clients MUST
  re-issue it as a new request with a new request ID" (changelog, major change
  9).
- **Cancel.** A cancel can arrive after the server finished the work. "Both
  parties MUST handle these race conditions gracefully"
  (`basic/patterns/cancellation`, "Timing Considerations").
- **State.** The revision has no session. A server that keeps state returns a
  handle, and the model sends it on the next call (`server/tools`, "Stateful
  Tools").

### 10.2 DBOS and the harness

- **DBOS.** "If a workflow fails while executing a step, it retries the step
  during recovery." Also, "once a step completes and is checkpointed, it is
  never re-executed." DBOS says: "Steps should be idempotent" (DBOS
  architecture docs).
- **The harness.** Each tool call is one DBOS step named
  `<tool>.<toolCallId>` (`harness/src/loop/tool-adapter.ts:1-8`, `:123-138`).
  The harness tool contract says: "a tool body must be safe to run again from
  its start" (`harness/src/tools/define-tool.ts:18-20`).
- **Retries.** `durableTools` turns step retries off by default
  (`@dbos-inc/vercel-ai` `0.5.4`, `dist/tools.js:88`, `:116`).

### 10.3 The risks

- **A repeated side effect.** The process can stop after the MCP server did the
  work and before DBOS wrote the checkpoint. Then recovery calls the tool again.
  For a tool that is not idempotent, the side effect occurs two times. A
  `notifications/cancelled` does not prevent this, because the server can finish
  before the cancel arrives.
- **A different process.** On recovery, the step runs against a new stdio
  process or a new HTTP request. A server with state in memory does not have the
  state of the first call.
- **A handle that expired.** A handle from an earlier step is in the checkpoint.
  The server can say that it expired, because the server sets its lifetime.
- **Unknown hints.** The hints come from a server that the user added. The
  specification tells a client not to make a decision from the hints of an
  untrusted server.
- **The input loop.** An `InputRequiredResult` needs a second request in the
  same step. If the step runs again, the server sees the first request again.

## 11. Open points for Inflexa

- **The era.** Select the legacy era, the `'auto'` probe, or a pin, and select
  where to store the era of each server.
- **The package.** Select `@modelcontextprotocol/client` v2, the v1
  `@modelcontextprotocol/sdk`, or `@ai-sdk/mcp`, and the version of
  `@ai-sdk/provider-utils`.
- **The Bun binary.** Do a test of a stdio child process from the compiled CLI
  binary. The SDK CI does not do this test.
- **The transports.** Select stdio only, or stdio and HTTP on `localhost`, or
  also remote HTTP with a static header. OAuth is necessary only for remote
  servers that use it.
- **The lifetime.** Select one process for each harness boot, for each run, or
  for each agent. Select the restart rule after a crash.
- **The record of a server.** Select the fields: `command`, `args`, `env`, `cwd`,
  `url`, `headers`, and a key reference. Select the variable syntax.
- **The child environment.** Select which variables the child gets, because the
  SDK default passes only a short list.
- **The names.** Select the prefix and the rule for characters outside
  `^[a-zA-Z0-9_-]`, and the rule for a full name over 128 characters (64 for a
  Chat Completions provider).
- **The result.** Select the map of each `content` block type, and of
  `structuredContent`, to the harness result. Select the size limit for an MCP
  result, against `TOOL_RESULT_CAP`.
- **The approval.** Select the default approval for an MCP tool, and the
  `grantKey` for a per-tool and a per-server grant.
- **A second run on recovery.** Select what the harness does when a step with a
  tool that is not idempotent runs again.
- **Input requests.** Select whether the harness declares elicitation, and how an
  `InputRequiredResult` reaches the user.
- **List changes.** Select whether a run sees a changed tool list, or only the
  next run.
- **Timeouts.** Select the startup timeout and the call timeout. The SDK default
  is 60 seconds.

## Sources

- MCP specification `2026-07-28`, changelog:
  <https://modelcontextprotocol.io/specification/2026-07-28/changelog>
- Transports, stdio, Streamable HTTP:
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports>,
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio>,
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http>
- Versioning and eras:
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning>
- Cancel and timeouts:
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation>
- Authorization:
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>
- Tools: <https://modelcontextprotocol.io/specification/2026-07-28/server/tools>
- Schema (`ToolAnnotations`):
  <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/0b22bfed6e94c0c7751046d2e845fac954cac8a7/schema/2026-07-28/schema.ts>
- Security best practices:
  <https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices>
- Claude Desktop local servers:
  <https://modelcontextprotocol.io/docs/develop/connect-local-servers>
- TypeScript SDK v2 at `919bb8e`:
  <https://github.com/modelcontextprotocol/typescript-sdk/tree/919bb8ea88b6e10e72c2f8b6218fad4cfdc40b2c>
- TypeScript SDK v2 docs: <https://ts.sdk.modelcontextprotocol.io/v2/>
- TypeScript SDK `v1.x` at `3b73021`:
  <https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x>
- SDK issues: <https://github.com/modelcontextprotocol/typescript-sdk/issues/2011>,
  <https://github.com/modelcontextprotocol/typescript-sdk/issues/1269>,
  <https://github.com/modelcontextprotocol/typescript-sdk/issues/709>,
  <https://github.com/modelcontextprotocol/typescript-sdk/issues/91>
- Claude Code MCP: <https://code.claude.com/docs/en/mcp>
- Claude Code permissions: <https://code.claude.com/docs/en/permissions>
- Claude Code errors: <https://code.claude.com/docs/en/errors>
- Claude API, define tools:
  <https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools>
- OpenAI OpenAPI spec:
  <https://github.com/openai/openai-openapi/blob/manual_spec/openapi.yaml>
- VS Code MCP configuration:
  <https://code.visualstudio.com/docs/copilot/reference/mcp-configuration>
- Cursor MCP: <https://cursor.com/docs/context/mcp>
- OpenCode MCP: <https://opencode.ai/docs/mcp-servers/>
- Codex MCP: <https://learn.chatgpt.com/docs/extend/mcp?surface=cli>
- AI SDK MCP: <https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools>
- DBOS steps: <https://docs.dbos.dev/typescript/tutorials/step-tutorial>
- DBOS architecture: <https://docs.dbos.dev/architecture>
