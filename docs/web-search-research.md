# Research: web search and page fetch tools for the harness, with SearXNG

> This document is research for a GitHub issue and for an OpenSpec change. It
> gives the facts and a recommendation. It is not a design.
>
> Sources: `nicobailon/pi-web-access` at `d0e323a` (npm `0.44.0`),
> `searxng/searxng` at `8137186`, the SearXNG documentation, the Node.js
> documentation, and inflexa `main` at `984d2b3`. Researched 2026-10-22.

## 1. The questions and the answers

1. **Can the harness use the `pi-web-access` package?** No. The package is an
   extension for the Pi agent. It is not a library. Section 2 gives the reasons.
2. **What can we use from it?** We can use its SearXNG client logic and its
   redirect rules as a reference. The harness already has the other parts that
   are necessary. Section 3 gives the list.
3. **Is a search tool sufficient?** No. A search gives titles, URLs, and short
   snippets. The agent must also read the pages that it selects. Thus the harness
   gets two tools: `web_search` and `web_fetch`. Section 3.2 gives the facts.
4. **What is necessary for SearXNG in our compose file?** One service, a settings file
   that the CLI writes, and a port on the loopback address. Section 4 gives the
   facts, and section 5 gives the integration points.

## 2. Why the harness cannot use `pi-web-access`

The package has the MIT license (`LICENSE`). Thus a copy of its code is legal
if we keep the copyright notice. The technical shape of the package stops a
direct use.

- **It exports only a Pi extension.** The npm package has no `main` field and no
  `exports` map (`npm view pi-web-access@0.44.0`). The bundle
  `dist/index.js` exports `default` (the extension factory) and three helpers.
  The factory takes the Pi `ExtensionAPI` (`index.ts:727`).
- **The other modules are TypeScript source.** The package ships `*.ts` files
  (`package.json`, `files`). Node.js "refuses to handle TypeScript files inside
  folders under a `node_modules` path" (Node.js docs, "Modules: TypeScript"). The
  harness runs on Node.js (`harness/CLAUDE.md`, "Commands"). Thus an import of
  `pi-web-access/searxng.ts` fails at runtime.
- **The configuration is global.** Each provider reads
  `~/.pi/agent/web-search.json` or a `PI_CODING_AGENT_DIR` directory
  (`utils.ts:11-37`), and the SearXNG URL can come from `SEARXNG_BASE_URL`
  (`searxng.ts:69-74`). Some modules read the path when they load
  (`searxng.ts:9`, `ssrf-protection.ts:16`). The harness rule is different: the
  embedder gives each value at its composition root (root `CLAUDE.md`, "The
  boundary between the CLI and the harness").
- **The MCP server has the wrong surface.** `pi-web-access-mcp` (`mcp-server.ts`)
  serves four tools. The `provider` argument lets the model select from all the
  providers (`mcp-tool-definitions.ts:17-22`). Thus SearXNG cannot be the only
  engine. The server also writes a page cache and clones GitHub repositories
  (`mcp-tool-definitions.ts:28-30`). The harness has no MCP client dependency
  (`harness/package.json`).
- **The size is too large for the task.** The npm package has 101 files and 10 MB
  unpacked. The SearXNG client is one file of approximately 230 lines
  (`searxng.ts`).

**The call:** build our own tools in the harness. Use `searxng.ts`,
`ssrf-protection.ts`, and `extract.ts` as the reference.

## 3. What to use from `pi-web-access`

### 3.1 The search

| Part | Reference | Use in inflexa |
| --- | --- | --- |
| The request | `searxng.ts:177-188` | `GET {base}/search?q=…&format=json`, with `time_range` when the caller sets it |
| The base URL rules | `searxng.ts:52-67` | Accept only `http:` and `https:`. Refuse a user name or a password. Remove the trailing slash, the query, and the fragment |
| The domain filter | `searxng.ts:126-162` | Add `site:` and `-site:` terms to the query. Then filter the results again by host, because some engines ignore `site:` |
| The time range | `searxng.ts:164-168` | Map `day`, `week`, `month`, and `year`. SearXNG accepts these four values (`searx/webadapter.py:95-101`) |
| The result shape | `searxng.ts:218-229` | Map `title`, `url`, and `content` (the snippet). Keep the SearXNG `answers`. Stop at `numResults` |
| The error text | `searxng.ts:203-216` | Give the HTTP status and the first 300 characters of the body. Give a separate error for a body that is not JSON |
| The redirect rules | `ssrf-protection.ts:267-302` | Obey each redirect in the tool code. Remove the configured headers on a cross-origin redirect (`searxng.ts:200`). A loopback exemption applies only to the configured origin |
| The tool surface | `web-tool-contract.ts:38-48`, `mcp-tool-definitions.ts` | `query` or `queries`, `numResults` from 1 to 20 (default 5), `recencyFilter`, and `domainFilter` with a `-` prefix to exclude a domain |

### 3.2 The page fetch

A search and a page fetch are two steps. `pi-web-access` has a `web_search`
tool and a `fetch_content` tool (`mcp-tool-definitions.ts`). The
`includeContent` option of `web_search` fetches each result with the same code
(`web-tool-core.ts:249-273`). Claude has the same two steps: a web search tool,
then a web fetch tool.

Do not port `includeContent`. If the tool fetches each result, the context gets
pages that the agent does not want. With two tools, the agent selects the pages
to read.

| Part | Reference | Use in inflexa |
| --- | --- | --- |
| The address guard | `ssrf-protection.ts:216-264`, `ssrf-protection.ts:393-440` | Accept only `http:` and `https:`. Resolve the host name. Find each loopback, private, link-local, shared (100.64.0.0/10), multicast, and reserved address, for IPv4 and IPv6. `pi-web-access` refuses these addresses. Inflexa asks the user (see below) |
| The redirect rules | `ssrf-protection.ts:267-302` | Obey a maximum of 5 redirects, and obey each redirect in the tool code. Do the address check again for each redirect |
| The size limit | `extract.ts:1339-1350`, `extract.ts:1191-1258`, `pdf-extract.ts:67-70` | HTML and text: 5 MB. PDF: 20 MB by default, 50 MB at most, and the first 100 pages. Refuse a body from the `Content-Length` header. Stop the stream when the body gets to the limit |
| The HTML extraction | `extract.ts:1471-1527` | Parse the page with `linkedom`. Extract the article with Readability, and use Defuddle if Readability fails. Change the article to Markdown with Turndown |
| The PDF extraction | `pdf-extract.ts` | `pi-web-access` uses `unpdf`. The harness already has `pdf-parse` (`harness/src/lib/regulatory-corpus/fetch-ich.ts`) |
| The inline limit | `web-tool-core.ts:291-300` | Return 30,000 characters by default. The harness tool output store keeps the remaining text |

**A gap to close.** `pi-web-access` resolves the host name for the check
(`ssrf-protection.ts:251`). Then `fetch` resolves the name again for the
connection (`ssrf-protection.ts:279`). Thus a DNS server can give a public
address for the check and a private address for the connection (DNS rebinding).
Our guard must do the check on the address that the connection uses. The
`lookup` option of `node:http` and `node:https` gives this, with no new
dependency.

**The private addresses.** The model selects the URL. Its context holds text
from outside: web pages, search snippets, papers, and data files. Thus an
injected instruction can make the agent fetch a private address:

- **The local stack.** Loopback has CLIProxyAPI (it holds the provider
  credentials), the DBOS admin port, SearXNG, and the other services of the
  user (`cli/src/lib/env.ts:200-205`).
- **The data goes out.** The response goes back to the model. A second
  `web_fetch` to a public URL can send the data out.
- **A managed deployment.** There, the cloud metadata address
  (169.254.169.254) holds credentials. The harness is host-agnostic, thus the
  safe default is in the harness.

`pi-web-access` refuses these addresses. An operator can add a CIDR range to
`ssrf.allowRanges`, but the name `localhost` stays refused (`README.md`,
"ssrf.allowRanges"). Inflexa can do better with the approval mechanism that
exists. `ToolContext.ask` (`harness/src/tools/define-tool.ts:168`) asks the user
to approve a concrete action. A host with no interactive surface gets
`UnavailableAsk`, which refuses each request
(`harness/src/tools/approval/contract.ts:88`). Thus `web_fetch` asks the user
before it fetches a private address. An `always` approval applies to the origin
(`grantKey`, `contract.ts:32`). A user can then fetch a page from a local
server, and a managed deployment refuses the address.

**New dependencies.** The HTML extraction uses a DOM, Readability, and a
Markdown converter. The harness has `cheerio` (`harness/package.json`), but it
does not have `@mozilla/readability`, `turndown`, or `linkedom`.

### 3.3 The parts to leave

Do not use these parts. The harness has a replacement, or the scope does not
include them:

- **The result storage** (`storage.ts`, `get_search_content`). The harness has a
  tool output store and the `read_tool_output` tool
  (`harness/src/tools/read-tool-output.ts:126`).
- **The HTTP client.** The harness has `apiFetchValidated` with a zod schema
  (`harness/src/tools/lib/api-utils.ts:94`). The Context7 tool and the GitHub
  search tool use it (`harness/src/tools/research/context7-docs.ts`,
  `search-github-repos.ts`).
- **The other providers, the curator UI, the browser cookies, the proxy support,
  and the video and YouTube extraction.**
- **The GitHub clone, the RSC extraction, the Jina reader fallback, and the
  authenticated fetch.**

## 4. SearXNG facts

- **The image.** `docker.io/searxng/searxng`. GHCR has a mirror
  (`ghcr.io/searxng/searxng`), and Docker Hub applies rate limits to pulls that
  have no authentication (SearXNG docs, "Installation container"). The tags are
  dated, for example `2026.10.19-81371861f`, and `latest` moves each day.
- **The port in the container.** 8080 (`container/docker-compose.yml`).
- **The configuration directory.** `/etc/searxng/settings.yml`. The cache
  directory is `/var/cache/searxng`.
- **The JSON format is off by default.** The default `search.formats` holds
  only `html` (`searx/settings.yml:84-86`). A request for a format that is not
  in the list gets `403 Forbidden` (SearXNG docs, "Search API").
- **The secret key.** The container stops with exit code 1 if
  `server.secret_key` is `ultrasecretkey` (`searx/webapp.py:1380-1382`). The
  entrypoint makes `settings.yml` from a template, with a random key, only when
  no file exists (`container/entrypoint.sh:81-96`). The template does not add
  `json` to the formats (`container/settings.template.yml`). `SEARXNG_SECRET` overrides the
  key (`searx/settings.yml:105`).
- **The limiter.** The limiter is off by default (`searx/settings.yml:97`). It
  necessitates a Valkey database (SearXNG docs, "server:"). The limiter and
  `public_instance` are not necessary for a private instance. Thus we do not add the Valkey
  service.

As a result, the CLI must write a `settings.yml` like this one:

```yaml
use_default_settings: true
server:
  secret_key: "<random value for each install>"
  limiter: false
  public_instance: false
search:
  formats:
    - html
    - json
```

## 5. Integration points in inflexa

### The harness

- Add `createWebSearchTool(deps)` and `createWebFetchTool(deps)` in
  `harness/src/tools/research/`. Use the factory form of
  `createSearchGithubReposTool`
  (`harness/src/tools/research/search-github-repos.ts:81`).
- The dependency is the base URL of SearXNG. The embedder gives it. The
  conversation agent gets it through `ConversationAgentDeps`
  (`harness/src/agents/conversation-agent.ts:117`), and the tool goes into the
  roster at `conversation-agent.ts:259`.
- When the embedder gives no URL, leave `web_search` out of the roster. Then the
  model never sees a tool that cannot work.
- SearXNG is not necessary for `web_fetch`. Thus `web_fetch` can also read a URL
  that the user gives.
- Each tool description must say that an empty result or a refused URL is a
  normal condition (root `CLAUDE.md`, "Agent-facing content").

### The CLI

- **The compose service.** Add a SearXNG service to `generateComposeFile`
  (`cli/src/modules/infra/compose.ts:139`). The service does not depend on the
  connection mode, the same as Postgres.
- **The image pin.** Pin the tag and the digest together, the same as
  `PROXY_IMAGE` (`compose.ts:21-34`). Add the image to the list in
  `composePullIfMissing` (`compose.ts:406`) and to the `composePull` error text
  (`compose.ts:363`).
- **The settings file.** Add a `file` mount source with a provisioner to
  `mountManifest` (`compose.ts:246`). Mount it read-only on
  `/etc/searxng/settings.yml`. The provisioner makes the random secret key one
  time, and keeps it on later runs.
- **The port.** Publish on `127.0.0.1` only, the same as the proxy and Postgres
  (`compose.ts:163-165`, `compose.ts:183-185`). Add a `searxng` member to
  `StackPorts` and to `stackPorts` (`cli/src/lib/env.ts:207-233`).

### The default port

The existing ports are 8317, 8318, and 8431 to 8436 (`cli/src/lib/env.ts:200-205`).
Developers often use 3000, 5000, 5173, 8000, 8080, and 8888. The SearXNG
documentation uses 8080 and 8888.

The recommended defaults:

- **Production: 28437.**
- **Development: 28438.**

Both ports are unassigned in the IANA registry (2026-10-22). Both ports are
below the ephemeral range of Linux (32768 to 60999), and below the range of macOS
and Windows (49152 to 65535). Thus an outbound socket does not take the port.

## 6. Decisions for the issue

- **The scope of the first change.** `web_search` and `web_fetch`, as two
  tools. The user selected this scope (2026-10-22).
- **The new dependencies.** `web_fetch` uses `@mozilla/readability`,
  `turndown`, and `linkedom` in the harness. The recommendation is to add them,
  because the harness has no HTML-to-Markdown converter. Defuddle is optional.
- **The private addresses.** Ask the user with `ctx.ask`. Do not refuse them
  in all conditions. The user selected this approach (2026-10-22).
- **The size limits.** 5 MB for HTML and text. 20 MB and 100 pages for a PDF.
  The user selected these values (2026-10-22).
- **The agents that get the tools.** The recommendation is the conversation agent
  only. The planner and the literature reviewer can get it later.
- **The ports.** The recommendation is 28437 and 28438, from section 5.

## Sources

- `pi-web-access`: <https://github.com/nicobailon/pi-web-access> at `d0e323a`
- SearXNG source: <https://github.com/searxng/searxng> at `8137186`
- SearXNG container install: <https://docs.searxng.org/admin/installation-docker.html>
- SearXNG Search API: <https://docs.searxng.org/dev/search_api.html>
- SearXNG `server:` settings: <https://docs.searxng.org/admin/settings/settings_server.html>
- SearXNG `search:` settings: <https://docs.searxng.org/admin/settings/settings_search.html>
- Node.js TypeScript support: <https://nodejs.org/api/typescript.html>
- IANA port registry: <https://www.iana.org/assignments/service-names-port-numbers/>
