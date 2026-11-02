# Tasks

## 1. The skill pack

- [x] 1.1 Write `skills/mdv-preparation/SKILL.md` with the workflow, the decision tree of the input, the conventions, the anti-patterns, and the table of the references.
- [x] 1.2 Write the references: the project contract, the AnnData route, the view recipes, the validation, spatial transcriptomics, spatial proteomics, scATAC-seq and multiome, memory and scale.
- [x] 1.3 Put each helper module in one fenced block with a `# file:` line, and make sure that each block compiles.
- [x] 1.4 Run the extracted modules on a raw CosMx run, and make sure that the validator reports zero errors.
- [x] 1.5 List the pack in `skills/README.md`.

## 2. The agent

- [x] 2.1 Add `harness/src/agents/sandbox/mdv-preparation-agent.ts` and its prompt.
- [x] 2.2 Register the agent in `harness/src/agents/sandbox/index.ts`.
- [x] 2.3 Change the roster count in `harness/src/agents/sandbox/test/catalog.test.ts` to 22.
- [x] 2.4 Run `bun run format:file`, `tsc -p tsconfig.build.json`, `inflexa-typecheck`, and `bun test src/agents` in `harness/`.
- [ ] 2.5 Run the full `bun test` and `oxlint` in `harness/` on a host with a container runtime.

## 3. The package

- [ ] 3.1 Decide how the store gets `mdvtools` (refer to `design.md`).
- [ ] 3.2 Add the package, and make sure that the load check imports `mdvtools.conversions` and `mdvtools.serverlite` on both architectures.
