# Spec Delta

## MODIFIED Requirements

### Requirement: Literature tools available to the conversation agent, sub-agents, and sandbox agents

The three literature tools SHALL be wired into the conversation agent
(`harness/src/agents/conversation-agent.ts`, via `createNcbiTools`), the
lookups of the run synthesizer (`harness/src/tools/research/synthesis-lookups.ts`),
and the analogical-reasoner sub-agent
(`harness/src/tools/research/generate-analogy-report.ts`); sandbox agents receive
them via the central tool registry when their `meta.tools` allowlist names them.
The in-process report builder does not wire literature tools — it reports on
existing analysis artifacts only.

#### Scenario: Conversation agent can search literature

- **WHEN** the conversation agent's tool array is inspected
- **THEN** it includes `search_pubmed`, `get_article_details`, and `get_article_full_text`

#### Scenario: Sandbox agents get literature tools via the allowlist

- **WHEN** a sandbox agent declares the literature tool names in `meta.tools`
- **THEN** `createSandboxAgent` resolves and adds them to that agent's tool array
