# Spec Delta

## MODIFIED Requirements

### Requirement: Literature tools available to the conversation agent, sub-agents, and sandbox agents

The literature tool `pubmed` (`createNcbiTools`) MUST be a script tool of the
conversation agent (`harness/src/agents/conversation-agent.ts`), which calls it
from `run_script` (refer to the script-tools capability). It MUST be a declared
tool of the lookups of the run synthesizer
(`harness/src/tools/research/synthesis-lookups.ts`) and of the
analogical-reasoner sub-agent
(`harness/src/tools/research/generate-analogy-report.ts`). Sandbox agents
receive it through the central tool registry when their `meta.tools` allowlist
names it. The in-process report builder does not wire literature tools — it
reports on existing analysis artifacts only.

#### Scenario: Conversation agent can search literature

- **WHEN** the script tools of the conversation agent are inspected
- **THEN** they include `pubmed`, and the tools of the agent do not

#### Scenario: Sandbox agents get literature tools via the allowlist

- **WHEN** a sandbox agent declares `pubmed` in `meta.tools`
- **THEN** `createSandboxAgent` resolves it and adds it to the tool array of that agent
