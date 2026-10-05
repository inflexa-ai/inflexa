# Tasks: resync-sandbox-agent-prompts

## 1. Microbiome prompt

- [x] 1.1 Remove the MetaPhlAn, HUMAnN and PICRUSt2 reference claims at `src/prompts/sandbox/microbiome-agent.ts:23-24`.
- [x] 1.2 Align the shotgun lines at `:28-31` and `:45-46` with the pack scope. The entry point is a profiled table.
- [x] 1.3 Replace the SparCC and propr recommendation at `:84-85` with the CLR computation note of `skills/microbiome/SKILL.md:144`.

## 2. Metabolomics prompt

- [x] 2.1 Correct the reference list at `src/prompts/sandbox/metabolomics-agent.ts:13` to XCMS, matchms and pymzml.
- [x] 2.2 Add the pathway-mapping hedge of `skills/metabolomics/SKILL.md:94` to the capability at `:30-31`.
- [x] 2.3 Make the pathway-enrichment figure at `:54-55` conditional on a resolved metabolite-set file.

## 3. Spatial omics prompt

- [x] 3.1 Mark `sq.gr.ligrec` at `src/prompts/sandbox/spatial-omics-agent.ts:29-31` as unavailable, per `skills/spatial-omics/SKILL.md:109-112`. Report a blocker, do not substitute.

## 4. DNA methylation prompt

- [x] 4.1 Correct the reference claims at `src/prompts/sandbox/dna-methylation-agent.ts:13-14`. The pack holds minfi, champ, dmrcate, epidish and methylclock only.
- [x] 4.2 Carry the IDAT-pipeline constraint of `skills/dna-methylation/SKILL.md:12-25` into the prompt workflow lines.
- [x] 4.3 Align the Bismark line at `:23` with the pack. Alignment and extraction happen upstream.

## 5. Network prompt

- [x] 5.1 Correct the reference claims at `src/prompts/sandbox/network-agent.ts:13-14`. The OmniPath reference lives in a different pack.
- [x] 5.2 Replace the pre-staged-parquet assertion at `:26-27` with the resolve-from-inventory rule of `skills/network-regulatory/SKILL.md:47-50`.

## 6. Verify

- [x] 6.1 Run `npx tsc --noEmit` in `harness/` and make sure that it is clean.
- [x] 6.2 Run `bun run format:file` on the five changed prompt files.
- [x] 6.3 Read each prompt against its packs, one claim at a time, per the new requirement.
