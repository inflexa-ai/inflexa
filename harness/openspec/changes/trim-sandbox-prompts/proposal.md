# Proposal

## Why

The system prompt of a sandbox agent repeated rules that its tool descriptions already carry, and five passages were false for the code:

- The package-link layer told the agent to report a package as missing after `link_packages` answered `unavailable`. `unavailable` is a failure of the link pass, and it says nothing about the package.
- The briefing sent the agent to `inspect_run` for the dependencies past the first five. `inspect_run` gives step paths only for a finished run, and the run of the step is still running.
- The data profiler got the orient core of the step agents. It promised a CPU section, an upstream, and a profile that the profiler itself writes.
- The profiler prompt said to call `submit_profile` "exactly once", but the tool expects a full resubmit after a refusal.
- The step standards ordered the delete of a failed script and its partial outputs. That delete can remove the decision record of a template.

A copy of a rule in a prompt drifts from the text that the model reads at the call, and each request pays for it.

## What Changes

- The package-link layer is deleted. The descriptions of `link_packages` and `list_available_packages` carry each rule, and the system prompt is the same with and without the seam.
- The briefing lists each completed dependency past the first five by its absolute summary path and output directory, with a cap and a count. `inspect_run` leaves `BASE_SANDBOX_TOOLS`.
- The briefing and scope sections move from the orient core to the step standards. The first message of the profiler names its resource budget.
- The orient core and the step standards keep only the facts that no tool description carries. The `cd` rule and the quote rule move into the `execute_command` schema.
- The per-agent prompts lose the call recipes that the bio tool descriptions carry. The keyed-source descriptions no longer tell a headless agent to "tell the user".
- The profiler "Do NOT" list keeps only the entries with a recorded failure or with content that the body does not state.

The composed system prompt falls from 25,754 to 19,089 characters for `bulk-transcriptomics-agent`, and from 39,437 to 30,838 for the data profiler. With the seam bound, as in the CLI, the old figures were 27,201 and 40,884.

## Impact

- `harness/src/prompts/sandbox-standards.ts`, `harness/src/prompts/briefing.ts`, `harness/src/prompts/sandbox/*.ts`
- `harness/src/agents/sandbox/shared.ts`, `harness/src/agents/sandbox/types.ts`
- `harness/src/tasks/data-profile.ts`
- The descriptions of `execute_command`, `read_file`, `grep`, `file_stat`, `drug_gene_interactions`, `gene_disease_evidence`, `comptox`, and `search_regulatory_approvals`
- Specs: harness-sandbox-agents, sandbox-format-standards, package-store, cheminformatics-agent, per-agent-tool-allowlist. Requirements that only pinned prompt wording are removed. A mixed requirement keeps only its code contract.
