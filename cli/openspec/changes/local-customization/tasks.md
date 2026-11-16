# Tasks

## 1. Harness dependency

- [x] 1.1 Link the working-copy harness of the change `agent-catalog` with `bun run harness:local`. Done when: the CLI typecheck reports the missing `catalog` input of `bootHarness`.

## 2. Config

- [x] 2.1 Add the `agents`, `mcp`, `connectors` and `credentials` blocks to `configSchema`, each with its own `.catch`, and stop reading `harness.bioKeys`. Done when: config tests cover each block, a bad block, and an old config with `bioKeys`.
- [x] 2.2 Resolve `${cred:<name>}` in MCP `env` and `headers` through `CredentialSource`. Done when: a test resolves an env credential and a helper credential, and `config.json` keeps only the reference.

## 3. Agent files and skills

- [x] 3.1 Read `~/.config/inflexa/agents/*.md` with `Bun.YAML.parse`, and build a custom entry or a draft with its gaps. Done when: tests cover each draft condition of the `custom-agents` spec.
- [x] 3.2 Add the import: drop the role tools, map each MCP naming form to a server, drop `model`, keep each other tool as a gap. Done when: tests import a Claude Code file, a Copilot file and a Gemini file.
- [x] 3.3 Add the clone of a built-in executor with its resolved attachments. Done when: a test clones `analyst` with a user change and reads the new file.
- [x] 3.4 Build the file `SkillStore` over the built-in root and `~/.config/inflexa/skills/`, and leave out a custom skill with a built-in name. Done when: tests cover a custom skill, a collision and an upgrade that keeps the custom skills.

## 4. MCP sign-in

- [x] 4.1 Add the token store: the macOS Keychain with the `0600` file fallback, and the `0600` file on Linux and Windows, keyed by the endpoint URL. Done when: tests cover each platform branch and a refused Keychain write.
- [x] 4.2 Add the `OAuthClientProvider` over the token store, and the browser flow of `mcp auth`. Done when: a test signs in to a local OAuth fixture server and the next call carries the token.
- [x] 4.3 Add `mcp logout` (revoke, then delete) and the token cleanup of `mcp rm`. Done when: a test makes sure that no token or registration remains.

## 5. Composition root

- [x] 5.1 Build the `AgentCatalog` from the files, the skill roots and `config.json`, read again at each call. Give it to `bootHarness`, and remove `skillsDir`, `bioKeys` and `buildAgent` from the composition. Done when: a test adds an agent file to a running server and the next plan lists it.

## 6. Commands and routes

- [x] 6.1 Add the routes under `/api/v1` for agents, skills, connectors, credentials and MCP servers, with the client functions. Done when: route tests cover each operation of the design table, and a prompt edit of a built-in agent is refused.
- [x] 6.2 Add the command groups `agent`, `skill`, `connector`, `credential` and `mcp` through `registerAction`, with the policies of the design table. Done when: the policy snapshot test shows the new commands, and a `run_inflexa` test refuses `mcp add`.
- [x] 6.3 Print the warning about repeated calls on `mcp add`. Done when: a test reads the warning in the output.
- [x] 6.4 Add the new commands to the CLI reference docs. Done when: the docs check of `cli-reference-docs` passes.

## 7. Help groups

- [x] 7.1 Group the root commands with `helpGroup()`, and move the Paths and Environment tables to `inflexa help env`. Done when: a test walks the top-level commands and finds a group for each, and the root help holds no Paths table.

## 8. Integration

- [x] 8.1 Run the CLI end-to-end. Import a Claude Code agent, and attach a stdio MCP fixture and a keyed connector. Run an ad hoc step on that agent. Done when: the step completes and the step row holds the agent name and the prompt hash.
- [x] 8.2 Run the full CLI suite one time. Done when: the suite passes.
