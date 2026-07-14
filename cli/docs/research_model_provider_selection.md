# Research: user-owned model & provider selection (decoupling from CLIProxyAPI)

> Grounding document for an OpenSpec (opsx) change. It captures (1) why PR #70 stalled, (2) the
> stated requirements, (3) how the ecosystem (Mastra, Bifrost, OpenCode) models the same problem —
> verified against source, (4) inflexa's current wiring across `cli/` and `harness/`, and (5) the
> design surface and open questions an opsx proposal must settle. It is research, not a design:
> decisions appear as options with trade-offs unless already settled by the user.
>
> Sources: `mastra-ai/mastra` @ `bd4d720` (main), `maximhq/bifrost` @ `59096c8` (main), OpenCode
> checkout (local), inflexa branch `record-model-agent`
> (post-4aef978). Researched 2026-07-10.

## 1. The trigger: PR #70 and why it points at a deeper problem

Issue #68 asks the signed provenance document to record **which model reasoned about each
model-driven activity**. PR #70 (`record-model-agent`) implements it, but its identity story
exposed the real gap across two review rounds:

- Round 1: the original `ProvModelRef` was a closed union over the harness's two provider kinds
  (`anthropic` | `openai-compatible`) plus an endpoint host — rejected (protocol kinds are not
  provider identity; the endpoint had no production wiring).
- Interim (6bb121b): an opaque verbatim model id — rejected, because dropping the provider loses
  the fact reviewers most want.
- Round 2 (4aef978): the `{provider}/{model}` convention — but since the CLI only holds **bare
  proxy ids** (`claude-…`, `gpt-…` from CLIProxyAPI `/models`), the provider slug is **derived by
  substring-matching** the model family (`modelProvider()`, `cli/src/modules/proxy/models.ts:100`),
  recording `unknown/{id}` for unrecognized families. A signed provenance document thereby records
  an *inferred* provider — the "fabricating provenance rather than capturing it" the same PR had
  argued against one round earlier.

**Root cause:** provider and model are not user-owned configuration anywhere in inflexa.
CLIProxyAPI's `/models` list is the only source of model identity, and the provider is not a fact
the system holds at all. Once provider+model become configured facts threaded to the harness,
PR #70's provenance record becomes a trivial read-through — no derivation table, no `unknown/`.

## 2. Requirements as stated (2026-07-10)

1. **CLIProxy becomes optional.** During `inflexa setup` and via config, the user chooses:
   CLIProxyAPI **or** a direct endpoint given by env vars (`INFLEXA_*_API_URL` +
   `INFLEXA_*_API_KEY`; exact names delegated) that can point at any provider (Anthropic, OpenAI,
   …). CLIProxy "should not control what models and providers the user chooses."
2. **Per-agent model selection.** During setup, in config, **and** from the command palette, the
   user picks the model (from the wired provider) for each agent the harness runs — believed to
   be two (conversational, sandbox); §5.4 inventories the actual seats from code.
3. **OpenCode parity as the UX reference** (command-palette screenshots): `Connect provider`
   (Provider group), `Switch model` (`ctrl+x m`), `Switch agent` (`ctrl+x a`).
4. **Then provenance:** with provider+model as configured facts, PR #70's intent (model agent in
   the PROV document) lands without inference.

## 3. Ecosystem conventions: Mastra & Bifrost (claim verified against source)

Claim under test: both have a TypeScript type shaped like `` type ModelId = `${string}/${string}` ``.

### 3.1 Mastra — partially correct (correct in the narrow literal sense)

- The exact open template-literal type **does exist**, but on the **config-object** form, not the
  headline magic string — `packages/core/src/llm/model/shared.types.ts:36-49`:

  ```typescript
  export type OpenAICompatibleConfig =
    | {
        id: `${string}/${string}`; // Model ID like "openai/gpt-4o" or "custom-provider/my-model"
        url?: string; apiKey?: string; headers?: Record<string, string>;
      }
    | { providerId: string; modelId: string; /* … */ };
  ```

  Note the second union arm: Mastra ALSO accepts the pair as two separate fields.
- The magic-string type behind `new Agent({ model: "openai/gpt-4o" })` is **not** the open pair —
  it is a **generated union of concrete `provider/model` literals** (from a `ProviderModelsMap`
  synced from models.dev's `api.json`; the generated file is ~4,873 lines) widened with
  `(string & {})` for autocomplete-without-rejection — `provider-types.generated.d.ts:4856-4866`:

  ```typescript
  export type ModelRouterModelId =
    | { [P in Provider]: `${P}/${ProviderModelsMap[P][number]}` }[Provider]
    | `mastra/${ProviderModelsMap['openrouter'][number]}`
    | (string & {});
  ```

- The full model prop union (`MastraModelConfig`, `shared.types.ts:81-93`) accepts the magic
  string, the config object, or a live AI-SDK model instance (`LanguageModelV1..V4`).
- Runtime parsing splits on the **first** slash only, so nested ids like
  `openrouter/google/gemini-2.5-flash` keep the remainder as the model
  (`provider-registry.ts:388-409`); validity is registry membership, not string shape
  (`isValidModelId`, `provider-registry.ts:596-599`).
- Introduced in `@mastra/core` 0.19.0 (PR mastra-ai/mastra#8235, merged 2025-09-30).

### 3.2 Bifrost — wrong on the TS-type claim, right on the wire convention

- Bifrost has **no TypeScript SDK** (verified: maximhq org repo listing, npm search, official docs
  list a Go SDK + drop-in HTTP compat only). Its only TS — the admin UI — types model fields as
  plain `string` (`ui/lib/types/logs.ts:272`). A repo-wide search for a `${string}/${string}`
  template literal returned zero hits.
- The canonical Go representation is **two separate fields** on every request struct —
  `core/schemas/chatcompletions.go:14-21`:

  ```go
  type BifrostChatRequest struct {
      Provider ModelProvider `json:"provider"`
      Model    string        `json:"model"`
      // …
  }
  ```

  (`ModelProvider` is a string-typed enum of known providers, `core/schemas/bifrost.go:41-73`.)
- The `provider/model` single string exists **only at the wire/API boundary**, documented in prose
  (OpenAPI: `model: type: string, description: "Model in provider/model format"`, no pattern), and
  parsed into the pair with a known-provider guard so namespaced model names survive —
  `core/schemas/utils.go:91-106`:

  ```go
  // Only splits on "/" when the prefix is a known Bifrost provider, so model
  // namespaces like "meta-llama/Llama-3.1-8B" are preserved as-is.
  func ParseModelString(model string, defaultProvider ModelProvider) (ModelProvider, string) { … }
  ```

### 3.3 Broader ecosystem (secondary)

- **Vercel AI SDK v5 / AI Gateway**: same idiom as Mastra — `GatewayModelId` is a generated union
  of concrete slash literals closed with `(string & {})`.
- **OpenRouter**: `author/slug` ids (optional `:variant` suffix); the API field is a plain string.
- **models.dev**: the open provider/model registry whose `api.json` both Mastra's router and
  OpenCode consume. Entry shape: `{ id, name, api?, env: string[], npm?, models: {…} }`.

### 3.4 Takeaway

Nobody in this space publishes the open pair `` `${string}/${string}` `` as their public model-id
type. The recurring idioms:

1. **TS frameworks** (Mastra, AI SDK): generated union of concrete `provider/model` literals
   `| (string & {})` — autocomplete without rejection.
2. **Gateways** (Bifrost, OpenRouter): wire field is a plain string documented as
   `provider/model`, split on the FIRST slash server-side with a known-provider guard.
3. **Everyone holds the pair as two structured fields internally** (Mastra `providerId`+`modelId`,
   Bifrost `Provider`+`Model`, OpenCode `providerID`+`modelID`) — the slash string is a surface
   convention for config/wire/display; the structured pair is the source of truth.

Direction for inflexa: config and composition hold `{ provider, model }` as structured facts; the
slash string is a serialization (config shorthand, display, and the PROV agent name).

## 4. OpenCode implementation map (the UX reference, at source level)

Checkout note: this tree carries two parallel stacks — the legacy/V1 instance stack
(`packages/opencode`: `Provider` service, `auth.json`, plugin auth hooks, prompt loop) which the
*Connect provider* dialog and prompt path use, and a newer Effect-based V2 core
(`packages/core` + `packages/server`: `Catalog`/`Connector`/`Credential` in SQLite) which the
model dialog already reads. Both are mapped below; the concepts transfer either way.

### 4.1 Connect provider

- **Dialog**: `packages/tui/src/component/dialog-provider.tsx` — a `DialogSelect` titled "Connect
  a provider", opened by command `provider.connect` (slash `/connect`, `app.tsx:724-732`, marked
  `suggested` when nothing is connected). Popular providers are pinned by a priority map
  (`PROVIDER_PRIORITY`, dialog-provider.tsx:19-26), per-provider descriptions ("(API key)",
  "(ChatGPT Plus/Pro or API key)"), a trailing **"Other" = custom provider** entry, and a ✓
  gutter for already-connected providers.
- **Provider list source**: the **models.dev registry** — a live fetch of
  `https://models.dev/api.json`, disk-cached with a 5-minute TTL, hourly background refresh,
  optional compiled-in snapshot, and env overrides (`packages/core/src/models-dev.ts:142-240`).
  The server's `GET /provider` merges registry entries (filtered by config
  `enabled_providers`/`disabled_providers`) with connected providers
  (`server/routes/instance/httpapi/handlers/provider.ts:40-59`).
- **Auth methods** come from **plugin auth hooks** (`provider/auth.ts:41-47,109-127`); the
  fallback when a provider has no hook is a plain API-key prompt
  (`dialog-provider.tsx:148-153`). OAuth hooks return `{url, instructions}` plus either an
  auto-polling callback (device-code flow, e.g. GitHub Copilot,
  `plugin/github-copilot/copilot.ts:233-259`) or a paste-the-code callback. On success the
  credential is persisted, the server instance is disposed, the TUI re-bootstraps, and the flow
  lands **directly in the model picker scoped to that provider** (`dialog-provider.tsx:265-284`).
- **Credential storage**: `auth.json` (0600) in the XDG data dir —
  `{ "<providerID>": {type:"api",key} | {type:"oauth",refresh,access,expires} | {type:"wellknown",…} }`
  (`auth/index.ts:10-89`). No keychain. V2 moves this to a SQLite `credential` table keyed by
  connector, with active-credential switching and a one-time `auth.json` import
  (`core/src/credential/sql.ts:7-24`, `credential.ts:104-166`).
- **Env-var detection**: each registry provider declares its key env vars (`env: string[]`, e.g.
  `["ANTHROPIC_API_KEY"]`); at load, the first set var marks the provider connected with
  `source: "env"` and the key is injected into the SDK options at construction
  (`provider/provider.ts:1458-1482,1656`).
- **Custom provider** (base URL + key): the "Other" path stores only a credential and tells the
  user to configure the provider in `opencode.json` (`dialog-provider.tsx:94-131`). Config shape
  (`core/src/v1/config/provider.ts:76-121`): per-provider `{ name?, env?, npm?, api?,
  options: { apiKey?, baseURL?, … }, models: Record<string, ModelOverride> }` — an unknown
  provider's SDK package defaults to **`@ai-sdk/openai-compatible`**
  (`provider/provider.ts:1379-1384`), and non-bundled packages are npm-auto-installed and
  dynamically imported (`provider.ts:1717-1735`).

### 4.2 Model identity & switching

- **Identity is a structured pair everywhere internal**: branded `ProviderV2.ID` + `ModelV2.ID`,
  composite `ModelV2.Ref = { id, providerID, variant? }` (`core/src/model.ts:37-42`). The
  `"provider/model"` **string appears only in config** (`model: "anthropic/claude-2"` etc.,
  `v1/config/config.ts:74-79`) and CLI args, split at the **first slash** with the remainder kept
  as the model id (three identical `parseModel` implementations, e.g.
  `provider/provider.ts:1944-1950`) — so `openrouter/openai/gpt-5` works.
- **Prompt API carries the pair**: `PromptInput.model = { providerID, modelID }`
  (`session/prompt.ts:1571-1580`); the session row persists it as a JSON column
  (`core/src/session/sql.ts:51-55`).
- **Agents**: built-ins constructed in code (`build`, `plan`, `general`, `explore` + hidden
  `compaction`/`title`/`summary`; `agent/agent.ts:138-263`), merged with per-agent config
  (`model` string → pair via `parseModel`, plus prompt/permissions/temperature/variant,
  `agent.ts:265-292`). Agent shape includes
  `model?: { modelID, providerID }` (`agent.ts:35-56`).
- **Switch agent** is a trivial local-store write (`dialog-agent.tsx:20-30`), with `tab`/
  `shift+tab` cycling (`config/keybind.ts:127-128`). Switching changes (a) the agent name sent
  with the next prompt and (b) the **effective model**, because model choice is per-agent:
  `currentModel = modelStore.model[agent.name] ?? agent.model ?? fallbackModel` where
  `fallbackModel = args.model → config.model → recents → first available`
  (`context/local.tsx:207-253`).
- **Switch model** dialog enumerates the catalog (connected providers × non-deprecated models),
  shows Favorites/Recent sections, fuzzy search, and appends "Popular providers" entries when
  nothing is connected so the dialog doubles as onboarding (`dialog-model.tsx:26-168`). Selection
  is **session/TUI state, not config**: stored per-agent in memory and persisted to a TUI-local
  state file `~/.local/state/opencode/model.json` (`recent` capped at 10, `favorite`, variants)
  (`local.tsx:173-189,340`). The server consults the same recents file for its default-model
  resolution (`provider.ts:1884-1916`).
- **Resolution to the wire**: user message records the pair → loop `getModel(providerID, modelID)`
  → `getLanguage` builds/caches the AI-SDK model instance per `"provider/model"` (options merge,
  baseURL substitution, key injection, bundled-or-npm SDK factory, per-provider loader quirks) →
  `streamText({ model: wrapLanguageModel(...) })` (`session/llm.ts:95-343`,
  `provider.ts:1609-1800`).

### 4.3 What OpenCode records about which model produced a message

Every assistant message is stamped with the **resolved** pair plus the agent:
`{ modelID, providerID, agent, variant?, cost, tokens, … }` (`core/src/v1/session.ts:451-483`;
write site `session/prompt.ts:1239-1254`). User messages record the *requested* model.
`ModelSwitched`/`AgentSwitched` events mirror changes onto the session row
(`core/src/session/projector.ts:346-352`). The record is **functionally used on replay**: when
history is re-sent to a different model, provider-specific metadata is stripped and reasoning
downgraded to text (`session/message-v2.ts:256,373-381`). This is the direct analogue of PR #70's
provenance goal — OpenCode captures the pair at the moment of resolution and stores it on the
artifact it produced.

(Gap noted: the "AI SDK provider" menu entry visible in some OpenCode builds does not exist in
this checkout — its role is covered by "Other" + config `npm`/`api` fields.)

## 5. inflexa current state: every model/provider touchpoint

Verified on branch `record-model-agent`. Organized: how the model/provider is chosen today →
where it flows → what the harness actually does with it → the UI surfaces a redesign touches.

### 5.1 The CLIProxy coupling, concretely

- **The endpoint is a hard-coded constant, deliberately not user-overridable** —
  `cli/src/lib/env.ts:58-65`: `const cliproxyPort = 8317;` with
  `cliproxyApiUrl: http://localhost:8317/v1` (env.ts:185-192). Comment: "We own the container, so
  the endpoint is intentionally NOT user-overridable — it is not read from process.env."
  **No env var in the CLI names a model, provider, endpoint, or key today** (full inventory: log
  level, OTEL, Auth0 build vars, dev/test flags only).
- **The client API key is minted at setup and regexed back out of the proxy's YAML** —
  `proxyConfig()` writes `api-keys: - "sk-…"` (`modules/infra/setup.ts:432-440`); `readApiKey()`
  re-extracts it with a regex over the file (`modules/proxy/models.ts:41-48`).
- **Provider auth = CLIProxyAPI OAuth login flows**, one per account kind (`setup.ts:365-393`):
  `gemini|openai|claude|qwen|iflow`, each a throwaway `docker run` of the proxy image with a
  `--claude-login`-style flag and a callback port; credentials land as files under
  `env.cliproxyAuthDir`. "Authenticated" = any non-dot file exists in that dir (`setup.ts:457-462`).
- **Model identity comes only from the proxy's `/models` list** — `resolveModelId()`
  (`modules/proxy/models.ts:51-65`) + `pickDefaultModel()` (:80-88) ranking by family substring
  (claude > gpt > gemini > qwen, fallback `ids[0]`), cached per process.
- **One provider construction site in the whole CLI** — `modules/harness/runtime.ts:444`:

  ```ts
  const provider = createAnthropicProvider({ baseURL: env.cliproxyApiUrl, token: apiKey, model, resolveBilling });
  ```

  Always the Anthropic Messages protocol at the proxy URL. This coupling is why boot rejects a
  non-Claude auto-resolved model (`model_not_claude` guard, runtime.ts:342-358): a gpt/gemini id
  wired into the Anthropic route would fail only after the sandbox spun up.

### 5.2 Config today

- User config: JSON at `env.configPath`, zod schema in `lib/config.ts:11-75` (telemetry, theme,
  runtime, keybinds, postgres, `harness: z.unknown()`, `embedding`).
- The `harness.*` shape is CLI-owned (`modules/harness/config.ts:15-49`):
  `model: z.string().optional()` — resolved as `model: string | null` where "`null` means resolve
  the default from the proxy's `/models` at boot" — plus bioKeys, sandboxImage, resourceLimits,
  adminPort, skillsDir, templatesDir. **Nothing in the product ever writes `harness.model`** (the
  only `harness`-key writers are the setup budget prompt and `sandbox pull`); it is hand-edited
  only.
- **The embedding block is the working precedent for provider decoupling** (`config.ts:56-63`,
  `modules/embedding/resolve.ts:41-85`): a `mode`-discriminated union — `local` (in-process GGUF)
  | `api-key` (direct OpenAI-compatible endpoint: `baseURL ?? "https://api.openai.com/v1"`, token,
  model, dimensions — "never through the chat proxy") | `off`. The chat path can mirror this shape.

### 5.3 What the harness actually does with "model" (the decisive fact)

- The provider seam (`harness/src/providers/types.ts:38-57`): `AgentChat`/`ChatProvider` with
  **no model field on `ChatRequest`** (`system, messages, tools, toolChoice?, providerOptions?`).
  **The wire model is baked into the provider at construction** — `AiSdkProviderConfig`
  (`providers/ai-sdk.ts:19-36`):

  ```ts
  export type AiSdkProviderConfig =
      | { kind: "anthropic"; baseURL?; apiKey; model; fetch?; capabilities? }
      | { kind: "openai-compatible"; name; baseURL; apiKey?; model; fetch?; capabilities? };
  ```

  `createConfiguredAiSdkProvider` (:154-172) builds the AI SDK `LanguageModel`
  (`createAnthropic(...).chat(model)` or `createOpenAICompatible(...).chatModel(model)`).
  **The curated barrel exports only `createAnthropicProvider`** (`index.ts:75-76`); the
  openai-compatible path exists but is reachable only via a deep subpath — not the front door.
- **Every per-seat `model` field in the harness is a label, not a wire value.**
  `loop/types.ts:22-34`: "the model id (provenance / metric label — the `ChatProvider` owns the
  wire model)". Verified: `AgentDefinition.model` has **zero consumers** in `harness/src`;
  `structuredLlmCall`'s `model` option is a dead parameter (declared, never put in the request).
  Consequence: **a per-seat model split requires per-seat provider instances** (or reintroducing
  `model` into `ChatRequest`) — today two seats cannot differ even in principle.
- Harness specs already promise embedder-supplied endpoint/key/model:
  `ai-sdk-provider-runtime/spec.md:9-21` — "The harness SHALL accept AI SDK-compatible language
  model instances or endpoint/key/model configuration from the embedder at runtime assembly. The
  harness SHALL NOT hard-code a single provider family as the only model path."
- Spec debt found in passing: `agent-llm-config/spec.md` and the `maxOutputTokens` requirement in
  `harness-providers/spec.md` describe pre-AI-SDK code that no longer exists (zero grep hits for
  `llm-capabilities|maxOutputTokens` in `harness/src`).

### 5.4 The actual agent seats (stated guess: two; code says more, in two tiers)

One config id (resolved once at boot) threads into everything — "D6" is a **CLI** archived
decision (`cli/openspec/changes/archive/2026-07-03-embed-execute-analysis/design.md:183-186`:
"`synthesisModel = model` (one model id in the cli config; splitting is a later config concern)"),
not a harness spec.

| Tier | Seat | Where |
|-|-|-|
| user-facing | **Conversation agent** (chat) | `runtime.ts:528-541` → `ConversationAgentDeps.model`; sub-agents inherit it: planner (`generate-plan.ts:480`), literature reviewer, analogy reasoner, report builder |
| user-facing | **Sandbox/step agents** (~22 catalog agents + data profile + ephemeral runner) | `buildStepAgent` (`run_deps.ts:81-89`), `buildSandboxStepDeps` (:138-151), data-profile bundle (`runtime.ts:508-519`) |
| internal | **Run synthesis** | `ExecuteAnalysisDeps.synthesisModel` (`run_deps.ts:167-184`) |
| internal | **Post-step metadata/summary** | `SandboxStepDeps.model` → `post-step-pipeline.ts:81,104` |
| internal (untriggerable in cli) | **Target assessment** decision+synthesis | `buildExecuteTargetAssessmentDeps` (`run_deps.ts:220-229`) |
| provenance | the composed `{provider}/{model}` into both prov emitters | `run_deps.ts:144,182` |

The "two agents" intuition matches the **user-facing** tier: conversational vs sandbox. The
internal seats exist in the deps types but all alias the one id today. The design must decide
which seats are user-selectable and which internal seats follow which user-facing seat.

### 5.5 UI surfaces a redesign touches

- **Command palette** (`tui/commands.tsx:62-77`): `Command` registry — one entry per command
  (`id, title, category, keybind?, enabled?, run`). Pattern for a model switcher: `ThemePicker`
  (:152-173) — `SelectDialog` over options + `writeConfig({...readConfig(), theme: id})`;
  boot-gated commands follow `analysis.reprofile` (:754-767, refuses unless
  `bootState().phase === "ready"`).
- **Config UI** (`tui/app_config.tsx`): telemetry toggle, theme + runtime radio groups, postgres
  text fields — draft/save via `writeConfig`. No harness/model/embedding settings today.
- **Boot state already carries the resolved model but nothing renders it** —
  `tui/hooks/boot.ts:25,67`: `{ phase: "ready"; model: string }`; no reader exists. (The REPL
  prints it: `chat.ts:118` "Runtime ready — model ${runtime.model}".)
- **Setup** (`inflexa setup`, `cli/src/cli/index.ts:283-322`): flags `--provider`, `--no-auth`,
  `--no-start`, `--no-postgres`, `--embeddings <mode>` — where a "CLIProxy or direct endpoint"
  choice would land.
- **Chat turn wiring**: the model is **not** passed per turn — `runChatTurn` (`turn.ts:140-208`)
  receives the pre-built `conversationAgent` + a `createStreamingChat(runtime.provider, …)`
  wrapper (`tui/hooks/conversation.ts:806-821`, `chat.ts:179`). A mid-session model switch means
  rebuilding the provider (and everything closed over it), not flipping a field.

### 5.6 This branch's provenance delta (PR #70) — what becomes trivial

11 source files: `ProvModelId` type; required `model` on
`prov.step_completed`/`prov.command_executed`; recorder → `appendModelAgent` (model as
`prov:SoftwareAgent` + `inflexa:Model`, `actedOnBehalfOf` the CLI agent, associated with
step/command activities); bridge emitters take the composed name at construction;
`RunEngineComposition.modelProvider` + the `modelProvider()` family-sniffing table (marked
`TODO(extend)` pending exactly this change). Once config holds `{provider, model}` as facts, the
derivation table is deleted and the emitters read the configured identity — the PROV mechanics
(agent QNames, delegations, dedup ids) carry over unchanged.

## 6. Design surface for the opsx change

### 6.1 Constraints already settled (by repo rules or review history)

- **Harness-first** (root `CLAUDE.md`): model/provider selection is a harness-owned capability —
  "its capabilities, concepts, and configuration surface are harness-owned and host-agnostic…
  Design new capabilities harness-first, then wire them from the embedder." The palette, setup
  flow, and env vars are CLI realizations of a harness-owned concept. The harness half is mostly
  *already there* (`AiSdkProviderConfig`, the `ai-sdk-provider-runtime` spec promise); the gaps
  are (a) it isn't exported from the curated barrel, and (b) per-seat providers don't exist.
- **The provider is a configured fact, not a derivation** — `modelProvider()` and its
  `TODO(extend)` retire with this change; `model_not_claude` becomes a protocol-configuration
  concern rather than an id-sniffing guard.
- **Structured pair as source of truth, slash string as surface** (§3.4, §4.2) — config may
  *accept* `"anthropic/claude-opus-4-8"` as shorthand (split on first slash, remainder = model),
  but composition, events, and seams carry `{ provider, model }` fields. `ProvModelId` remains
  the serialized display/provenance form.

### 6.2 The shape suggested by the evidence (updated with the settled decisions below)

1. **Harness**: promote provider configuration to the front door — export the endpoint/key/model
   config path (today's deep-subpath `createConfiguredAiSdkProvider`) or a harness-owned
   `ModelBackendConfig` concept. One shared backend connection; per-seat provider *instances* are
   still required mechanically (the wire model is baked into each `ChatProvider`, §5.3), but they
   are two instances of the same connection differing only in the bound model.
2. **CLI config**: a `mode`-discriminated chat-provider block mirroring the embedding precedent —
   `{ mode: "cliproxy" }` (today's behavior: proxy endpoint, proxy key) | `{ mode: "direct", … }`.
   Per D-ENV below, config/state names the provider and models; env supplies the endpoint and
   secret for `direct` mode, read through `lib/env.ts` (the sole `process.env` reader). Candidate
   names: `INFLEXA_MODEL_API_URL` / `INFLEXA_MODEL_API_KEY` (final names open).
3. **Per-seat models**: user-selectable seats = conversation + sandbox (§5.4); internal seats
   (synthesis, post-step metadata, decision) follow an assigned user-facing seat until a reason to
   expose them appears. Per D-SHARE, both seats share the one provider connection and differ only
   in model id.
4. **Setup**: a "how do you connect to models?" step — CLIProxy (current OAuth container flow) vs
   direct endpoint (env-var detection or prompt) — plus a model-pick step per user-facing seat.
5. **Palette + config UI**: `Switch model (conversation)` / `Switch model (sandbox)` commands
   (SelectDialog; boot-gated), settings entries in `app_config.tsx`, and rendering the active
   model(s) from the already-carried `BootState`. Per D-LIVE, a switch applies live when the
   runtime is idle and is otherwise scheduled until all agent work settles.
6. **Provenance**: PR #70's emitters read the configured `{provider, model}` per seat; the
   family-derivation table is deleted. Per-event `model` stamping (already in PR #70) is exactly
   what makes a mid-run model switch honest: each step/command records the model that actually
   drove it.

### 6.3 Decisions settled by the user (2026-07-10)

- **D-ENV — follow OpenCode's split.** Config/state names the *selection* (provider, per-seat
  models); env vars supply the *connection* (endpoint URL + API key) for `direct` mode. Env is
  the credential channel, not a parallel config channel. (OpenCode reference: registry providers
  declare their key env vars and become "connected" when one is set, §4.1; base URLs live in
  config with `${VAR}` substitution available.) Final env var names still open (see below).
- **D-LIVE — model switching is live mid-session, gated on agent idleness.** A switch from the
  palette applies immediately **only when no run and no data profiling is ongoing**. If agent work
  is in flight, the change is **scheduled**: it takes effect after ALL agent work settles — never
  mid-run. Implementation note (§5.5): applying = rebuilding the affected provider instance(s)
  and everything closed over them (`runtime.provider`, `conversationAgent`, streaming chat), so
  the design needs a pending-selection state + an idle-transition hook. Confirmed by the user:
  an in-flight *chat turn* also counts as agent work — the swap lands between turns, never
  mid-stream. "Agent work" therefore covers at least: analysis runs, data profiling, chat turns.
- **D-FETCH — model pickers fetch dynamically where possible.** Options-in-a-list is the desired
  UX; dynamic listing preferred: `cliproxy` mode uses the proxy's `/models` (works today);
  `direct` mode queries the endpoint's model list (`/models` on openai-compatible; `/v1/models`
  on Anthropic). Fallbacks (models.dev enrichment, free-text entry) are open design details, not
  requirements.
- **D-SHARE — one shared provider connection across seats.** The conversational and sandbox
  agents never point at different providers; only their model ids may differ. Config therefore
  carries ONE connection (mode/endpoint/credential/provider) + a per-seat model map — not
  per-seat connections.

### 6.4 Open questions remaining for the opsx proposal

1. **Env vars: key only (recommended), URL dropped — pending confirmation.** OpenCode never
   collects a URL in its connect flow: known providers get the endpoint from the models.dev
   registry or the SDK default; custom providers put `baseURL` in the config file
   (`provider.<id>.options.baseURL`), with `${VAR}` env substitution available in config values —
   no URL env var exists (`dialog-provider.tsx:94-131,358-419`, `provider.ts:1634-1655`).
   Following that: the endpoint lives in the config connection block (authored by the
   setup/connect flow, which may prompt for it), and env carries only the secret —
   `INFLEXA_MODEL_API_KEY`. `INFLEXA_MODEL_API_URL` is not needed; OpenCode-style `${VAR}`
   substitution can cover env-driven URLs later if a headless need appears.
2. **Protocol selection in `direct` mode.** The harness speaks two protocols (`anthropic` |
   `openai-compatible`). Explicit config field, or provider-implied (e.g. `provider: "anthropic"`
   → Messages protocol, everything else → openai-compatible)?
3. **Selection persistence under D-ENV/D-LIVE.** OpenCode persists picks to a *state* file
   (recents/favorites), not config. For inflexa: persist the per-seat picks into `config.json`
   (survives reboot, single source), a state file (OpenCode parity), or both?
4. **Provider slug vocabulary.** Free-form open string (current PR #70 stance) vs validated
   against a registry (models.dev). Affects provenance semantics: attested-config vs
   registry-verified.
5. **CLIProxy's remaining role.** In `cliproxy` mode, does the user still pick from `/models`
   (replacing `pickDefaultModel`'s silent ranking with an explicit choice), and what provider
   slug does a proxy-served model record — the account kind the proxy authenticated (known at
   login time: `gemini|openai|claude|qwen|iflow`), which would also retire the substring sniffing
   in `cliproxy` mode?
6. **Scope split.** One opsx change spanning harness + cli, or a harness-first change (provider
   config surface, per-seat providers, idle-transition hook) followed by a cli change (config/
   env/setup/palette/provenance)? Each subsystem owns its own spec tree, so artifacts land
   per-subsystem either way.
