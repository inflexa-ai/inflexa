## ADDED Requirements

### Requirement: The CLI realizes the session-page publisher

The runtime that the local server boots MUST bind the `makeSessionPagePublisher` seam that `assembleCoreRuntime` accepts. The realization MUST mint a page grant for the analysis of the scope and the thread of the call. It MUST mint into the grant store of the server process (refer to the `local-server` spec). The grant MUST carry the base URL of the local server, `http://127.0.0.1:<port>`, the token, and the expiry. Thus the `rendered` arm of `preview_report` carries the URL of the page beside its path, and a browser opens that URL through the page route.

The mint MUST give the grant in each case. One process mints and checks the token, thus no remote call can refuse it.

A runtime that no server holds MUST bind no publisher. The dev `run --plan` boots such a runtime. No route of that process serves a page, thus a grant would name a page that no route serves.

The composition MUST NOT bind `resolveReportPageUrl`. The eyes container holds the workspace root at the host path, and it opens the page through a `file://` URL. Also, the `Host` check of the server refuses a request from a container.

#### Scenario: A preview carries the URL of the page

- **WHEN** a report session renders a page under a runtime that the server booted
- **THEN** the `rendered` arm carries the page path and a granted access, whose URL names the local server and `/report-sessions/{analysisId}/{threadId}/index.html?t=`

#### Scenario: The URL of a preview opens the page

- **GIVEN** the URL that a preview gave
- **WHEN** a browser requests that URL within 900 s
- **THEN** the page route answers 200 with the page

#### Scenario: A runtime with no server binds no publisher

- **WHEN** the dev `run --plan` boots its own runtime
- **THEN** the composition binds no session-page publisher

#### Scenario: The eyes keep the file URL

- **WHEN** the composition root assembles the harness runtime
- **THEN** it binds no page-URL resolver, and a look opens the page through `file://`

## MODIFIED Requirements

### Requirement: Local realizations for every conversation dependency

The composition MUST realize the dependency surface of the conversation agent
from deliberate local wiring. It MUST use again the shared realizations of the
pool, the embedding, the workspace filesystem, the session tree, the bio keys,
the authorizer, and the launcher. It MUST supply these values:

- the conversation provider and model, resolved under the `conversation` role, for
  the chat agent and its conversation sub-agents
- the utility provider and model, resolved under the `utility` role, for the ad
  hoc router of the harness
- a skills path that the config can override, with the release and development
  defaults and the pre-flight gate
- an empty local Chrome config
- the `run_inflexa` host tool, through the host-tool seam.

The utility role MUST use the same configured connection and the same credential
realization as the other roles. The CLI MUST NOT supply routing prompts,
candidate agent ids, or selection decisions.

#### Scenario: Conversation and utility deps resolve to their roles

- **WHEN** the runtime composes a conversation model distinct from utility
- **THEN** chat/sub-agent traffic uses conversation and ad hoc routing uses utility over the same configured connection

#### Scenario: Report preview degrades visibly, report building does not

- **WHEN** a report session previews its page under a runtime that binds no session-page publisher
- **THEN** the result carries the page path alone, and report iteration and recording still work

#### Scenario: A report preview under the server carries the URL of the page

- **WHEN** a report session previews its page under the runtime of the local server
- **THEN** the result carries the page path and the URL of the page on the local server, and report iteration and recording still work

#### Scenario: The conversation agent carries the inflexa CLI host tool

- **WHEN** runtime composes the conversation agent
- **THEN** `run_inflexa` is present through `hostTools`
