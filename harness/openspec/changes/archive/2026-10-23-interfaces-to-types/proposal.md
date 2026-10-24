# Proposal

## Why

`@inflexa-ai/no-interface` reports 862 `interface` declarations in the harness
(umbrella #607, decision 5). 825 of them ship in `dist/*.d.ts`, so each one is a
live public-API declaration-merge target: an embedder can write
`declare module "@inflexa-ai/harness/<subpath>" { interface X { … } }` and change
the shape of a harness type at its own compile site today. The rule stays off
until each declaration is a `type`, and a type alias cannot be merged into.

## What Changes

- **BREAKING**: each `interface` declaration under `harness/src/` becomes a
  `type` alias (plain, generic, and `extends` forms included). For an embedder
  that merges a declaration into a harness interface today, the augmentation
  stops compiling with `TS2300` (duplicate identifier). The substitute is a
  local intersection type at the embedder's boundary, for example
  `type MyDeps = ConversationAgentDeps & { extra: … }`; structural typing accepts
  its values wherever the harness type is expected.
- The full pre-change merge surface — 825 declarations across 277 modules of
  `dist/*.d.ts` (790 exported, 35 module-internal) — is captured in
  `release-note.md` beside the release-note text, ready for the PR description
  and the next GitHub Release of `@inflexa-ai/harness`.
- `oxlint.config.ts` deletes the `"@inflexa-ai/no-interface": "off"` override;
  the preset default (`error`, `@inflexa-ai/oxlint-plugin` `index.js:118`) then
  guards the rule with no reports.
- Spec deltas update each spec statement that names the keyword construct or
  shows its syntax, so no spec record is false after the change.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

Each delta is a wording or snippet correction inside one requirement; no
requirement changes its normative content.

- `host-hooks`: the failure-shape snippet shows `type` aliases instead of
  `interface` declarations.
- `dynamic-resource-allocation`: the resource-shape snippets show `type` aliases.
- `resource-budgeted-scheduling`: the `ResourcePolicy` snippet shows a `type`
  alias.
- `harness-sandbox-exec`: the `SandboxClient` requirement names the exported
  construct a type, not an interface.
- `structured-logging`: the `Logger` requirement names the declared construct a
  type.
- `harness-providers`: the `requestTimeoutMs` requirement names `ChatProvider` a
  type.
- `harness-agent-loop`: the tool-output-store requirement calls the store a
  loop-layer type.
- `harness-thread-history`: the conversation-scope scenario inspects the
  `ThreadHistory` type.
- `per-agent-tool-allowlist`: the tools scenario inspects the `AgentMeta` type.
- `agent-roster`: the field-list scenario inspects the `AgentMeta` type.
- `harness-sandbox-agents`: the directory-structure requirement lists the
  `AgentMeta` type in `types.ts`.
- `tool-approval`: the `data-ask` part requirement lists the contract layers as
  type, schema, and part-registry entry.
- `harness-embedder-exports`: the front-door scenario writes a literal of a
  dependency type.

## Impact

- **Code**: every `interface` declaration under `harness/src/` (862 rule reports
  on the pinned run: 797 in non-test source, 65 in test files), including the
  public seams (`RunAuthorizer`, `ArtifactRegistry`, `RunCharge`,
  `UsageRecorder`, `RunLauncher`, `Logger`, `ChatProvider`, `EmbeddingProvider`),
  the deps bags, the contracts, and the test doubles that implement them.
  Members, names, generics, and `implements` clauses are unchanged; each
  `extends` clause becomes an intersection (`type X = A & B & { … }`).
- **Public API**: the published `.d.ts` surface keeps every name and member, but
  each merged-into surface disappears. Release note required (umbrella #607,
  decision 5); no in-repo changelog exists, so the note ships in the PR
  description and the GitHub Release body.
- **Tooling**: `oxlint.config.ts` drops one override entry. `bun run lint`,
  `bun run typecheck`, and `bun test` must pass; `tsc -p tsconfig.build.json`
  must emit a `dist/` whose `.d.ts` files contain zero `interface` declarations
  and the same exported names as before.
- **Out of scope**: lint reports of rules that other children of #607 own, and
  generic "seam interface" prose in specs, `CLAUDE.md`, and `CONTEXT.md` that
  names the contract sense rather than the keyword.
