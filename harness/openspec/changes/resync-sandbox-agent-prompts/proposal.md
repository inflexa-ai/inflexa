# Proposal: resync-sandbox-agent-prompts

## Why

Some sandbox agent prompts claim pack content that the pack does not hold, or
they recommend a tool that the pack names as unavailable. `validateAgentSkills`
never reads the prose, thus the drift stays green until an agent acts on it.
This is roadmap item 29, wave 1. The roadmap names three prompts. A full
comparison of each prompt against its packs found five:

- `src/prompts/sandbox/microbiome-agent.ts:23-24` claims API references for
  MetaPhlAn, HUMAnN and PICRUSt2. `skills/microbiome/` holds none of them,
  and `SKILL.md:55` puts shotgun profiling out of scope. The prompt at
  `:84-85` recommends SparCC and propr, which `SKILL.md:144` says are not
  installed.
- `src/prompts/sandbox/metabolomics-agent.ts:13` claims CAMERA and limma
  references that the pack does not hold, and it omits pymzml, which the pack
  holds. The prompt at `:30-31` demands pathway mapping without the hedge of
  `SKILL.md:94`, and `:54-55` makes the enrichment figure unconditional.
- `src/prompts/sandbox/spatial-omics-agent.ts:29-31` recommends
  `sq.gr.ligrec`, which `skills/spatial-omics/SKILL.md:109-112` marks as
  unavailable and tells the agent to report as a blocker.
- `src/prompts/sandbox/dna-methylation-agent.ts:13-14` claims dmrseq and SVA
  references that the pack does not hold, and the prompt does not carry the
  IDAT-pipeline constraint of `skills/dna-methylation/SKILL.md:12-25`.
- `src/prompts/sandbox/network-agent.ts:13-14` claims an OmniPath reference
  that lives in a different pack. The prompt at `:26-27` asserts a pre-staged
  parquet file. `SKILL.md:47-50` says that the file must resolve from the
  inventory.

The result is an agent that imports an absent package, calls an unavailable
function, or promises a figure it cannot make. Each failure burns iterations,
and a silent substitution is worse.

## What Changes

- Re-sync the five prompt summaries against their packs. The pack is the
  ground truth in each conflict.
- Remove each claim of a reference that no pack of the roster holds.
- Carry each availability caveat of the pack into the prompt, or drop the
  recommendation from the prompt.
- Align the scope lines of the prompt with the scope of the pack.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-skill-assignment`: a new requirement binds a prompt summary to its
  packs. A prompt must not claim content that no pack of its roster holds.

## Impact

- `src/prompts/sandbox/microbiome-agent.ts`
- `src/prompts/sandbox/metabolomics-agent.ts`
- `src/prompts/sandbox/spatial-omics-agent.ts`
- `src/prompts/sandbox/dna-methylation-agent.ts`
- `src/prompts/sandbox/network-agent.ts`
- Each edited prompt invalidates its own prompt-cache prefix one time. No
  pack changes, no roster changes, no schema changes.
