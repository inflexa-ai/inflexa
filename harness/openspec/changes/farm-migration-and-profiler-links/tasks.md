# Tasks: farm-migration-and-profiler-links (harness side)

## 1. The seam on the profile deps

- [ ] 1.1 Add `extendAnalysisFarm?: ExtendAnalysisFarm` (from `src/sandbox/types.ts:113`) to `DataProfileDeps` in `src/tasks/data-profile.ts`.
- [ ] 1.2 Thread the field into the profiler `SandboxAgentDeps` bag, beside `farmLockFile`.
- [ ] 1.3 Write a red test first: a bound seam gives the profiler roster `link_packages`, and an unbound seam does not.

## 2. The proof

- [ ] 2.1 Run `tsc -p tsconfig.json` and `bun test` for the touched suites.
- [ ] 2.2 Make sure that the profiler prompt layer renders the link guidance only when the seam is bound.
