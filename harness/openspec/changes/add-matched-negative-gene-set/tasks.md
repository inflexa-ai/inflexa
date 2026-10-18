## 1. The catalog

- [x] 1.1 Add `string-aliases-human` after `string-ppi-human` in `harness/src/reference-data/catalog.ts`: version 12.0, group `interaction-networks`, organism human, opt-in, with the aliases artifact. Do not change `string-ppi-human`.
- [x] 1.2 Add `mgi-mouse-human-homology` after `uniprot-idmapping-rat`, in the group `gene-identifiers`, with no organism.
- [x] 1.3 Add `impc-phenotyping`, `hpo-annotations`, `opentargets-mouse-phenotype`, and `opentargets-target-safety-event` after `hpa-proteinatlas`, in the group `phenotype-annotations`.
- [x] 1.4 Set the license of `hpo-annotations` to `LicenseRef-HPO` with the URL of the license page. Put the three conditions of the license in the code comment.
- [x] 1.5 Run `bun run format:file` on `catalog.ts`.

## 2. The catalog test

- [x] 2.1 Add the six ids to the ordered id list, at the three positions of task 1.1, task 1.2, and task 1.3.
- [x] 2.2 Add the six ids to the `notRecommended` list, and add their reason to the comment above the test.
- [x] 2.3 Add `www.informatics.jax.org` to `officialHosts`.
- [x] 2.4 Add `mgi-mouse-human-homology` and `opentargets-mouse-phenotype` to `organismAgnostic`, with a comment that gives the reason.
- [x] 2.5 Add the six ids to the sorted `availableIds` list.
- [x] 2.6 Run `bun test src/reference-data/catalog.test.ts` and make sure that it passes.

## 3. The skill pack

- [ ] 3.1 Write `skills/translational-safety/references/matched-negative-gene-set.md` from the first comment of the issue: the five steps, the two definitions with the pros and the cons, and the anti-patterns.
- [ ] 3.2 Add the rules of the review to the reference: the class rule, the isolated-gene rule, the viability rule with `exclude_lethal`, the tested prefix `IMPC_CBC_`, the joint cells, the studied-gene diagnostic, and the absent-source rule.
- [ ] 3.3 Add the source of the human Ensembl gene id, and the column tables of the design for the five output files.
- [ ] 3.4 Change each file name and each format of the draft into a description. The ontology file replaces `hp.obo`, and the gene-to-phenotype table replaces `genes_to_phenotype`. A dataset name such as Open Targets or MSigDB is a domain term, and it stays.
- [ ] 3.5 Write the words "matched negative" in the body of the reference, because `skill_search` is a substring match.
- [ ] 3.6 Make sure that the reference names no path, no file name, no format, and no tool. The tissue is a parameter, and the liver is the worked example.
- [ ] 3.7 Add a section to `skills/translational-safety/SKILL.md` that points to the reference. Add the row to the References table. Add the five anti-patterns to the "Do NOT" section.

## 4. The agent

- [ ] 4.1 Add the two capability phrases to `harness/src/agents/sandbox/translational-safety-agent.ts`. The first phrase names the three data classes and the two definitions.
- [ ] 4.2 Add `gene-lists` to `suitableFor`.
- [ ] 4.3 Run `bun run format:file` on the agent file.

## 5. The checks

- [ ] 5.1 Run `tsc -p tsconfig.build.json` in `harness`.
- [ ] 5.2 Run `bun test` in `harness`, without the DB suites.
- [ ] 5.3 Run the agent-facing content review of the root `CLAUDE.md` on the reference and on the `SKILL.md` section.

## 6. After this change

- [ ] 6.1 Open a GitHub issue for the acknowledgement of the HPO in the product, with the version of the HPO files.
