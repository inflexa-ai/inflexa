# Design

## Context

- `@inflexa-ai/no-interface` reports 862 declarations on the pinned run of
  umbrella #607 (797 in non-test source, 65 in test files). The declarations
  live under `harness/src/` and, in one place, `harness/scripts/`
  (`scripts/refresh-fixtures.ts:51`, `interface Difference` — found when the
  rule turned on, correcting the scout's claim that scripts hold none);
  `src/` holds no `.d.ts` file, no `declare module`, no `declare global`, no
  `export default interface`, and no multi-line `extends` header.
- A clean `rm -rf dist && tsc -p tsconfig.build.json` from the pre-change tree
  emits 825 `interface` declarations in `dist/*.d.ts`: 790 exported, 35
  module-internal, 277 modules, 785 unique names. (An earlier count of 831
  came from an incremental rebuild that left `.d.ts` files of fourteen deleted
  modules in `dist/`; six of their interface rows polluted the first inventory.
  The clean count reconciles with the issue's "about 825".)
- Empirical probes (`tmp/pi/704-merge-probe/` against the emitted `d.ts`):
  an embedder's `declare module` augmentation merges into a shipped interface
  **whether or not it is exported** — a non-exported declaration becomes
  nameable through the augmentation itself. After the change, the same
  augmentation fails with `TS2300: Duplicate identifier '<Name>'`. Both results
  were asserted with required-member type tests, not by reading prose.
- The plugin preset defaults `@inflexa-ai/no-interface` to `"error"`
  (`node_modules/@inflexa-ai/oxlint-plugin/dist/index.js:118`); the harness
  override at `oxlint.config.ts` sets it `"off"` with a `#704` comment.
- No changelog or release-notes file exists anywhere in the monorepo. Releases
  are GitHub Releases (`.github/workflows/release-harness.yml` tags; the body is
  written on the release). The breaking-change note therefore ships in the PR
  description and the next release body; the change carries the ready text in
  `release-note.md`.
- In-repo declaration merging: zero same-name duplicate interface declarations.
  `implements` clauses (a class can implement a type alias) and generic
  constraints are unaffected by the conversion.

## Goals / Non-Goals

**Goals:**

- Each `interface` declaration under `harness/src/` becomes a `type` alias with
  the same name, members, and generics.
- The published `dist/*.d.ts` surface keeps every exported name; only the
  declaration form changes.
- The rule turns on and reports nothing.
- The pre-change merge surface is recorded declaration by declaration, and the
  release note names the break and the substitute.

**Non-Goals:**

- No lint fix of rules that other children of #607 own.
- No rename, member change, or re-export change of any public type.
- No migration path, compatibility shim, or deprecation period (the umbrella
  decided the break; the note is the mitigation).
- No sweep of contract-sense prose that uses "interface" as a general noun
  (`CLAUDE.md`, `CONTEXT.md`, spec Purpose sections, "the seam interface").

## Decisions

1. **Conversion rules** (one codemod pass per form, prettier normalizes the
   output, `bun run format:file` on each changed file):
   - `interface X { … }` → `type X = { … };`
   - `interface X<T, U extends V> { … }` → `type X<T, U extends V> = { … };`
     (parameter constraints are unchanged).
   - `interface X extends A, B { … }` → `type X = A & B & { … };`
   - `interface X extends A {}` (empty body) → `type X = A;`
   - The `export` modifier, JSDoc, and indentation stay; the sweep covers
     `.ts` and `.tsx`, source and test files alike (the rule reports both).
2. **`extends` becomes an intersection.** Assignability of `A & B` equals
   interface extension for non-conflicting members, and a conflicting member
   would fail to compile as an interface today — the current clean typecheck is
   the proof of equivalence. The cost is coarser error messages and lazier
   display types; the full `bun run typecheck`, `bun test`, and build backstop
   the sweep. `src/providers/types.ts:188` (`ChatProvider extends AgentChat`)
   and the other 47 `extends` sites get a per-site read in the second pass.
3. **The merge-surface inventory is a built artifact, not a hand list.** It was
   generated from the pre-change `dist` build before any edit
   (`tmp/pi/704-merge-surface.tsv`, now embedded in `release-note.md`), one row
   per shipped declaration, exported and module-internal alike, because the
   probe showed both classes merge today.
4. **Name-preservation check.** `tmp/pi/704-dist-exported-before.tsv` holds
   every exported symbol of the pre-change clean `dist` (3,219 rows: 1,077
   functions, 834 consts, 790 interfaces, 490 types, 28 classes). The final task
   rebuilds `dist`, regenerates the list, and diffs: every row must survive with
   only the 790 `interface` rows becoming `type` rows, nothing added or removed.
5. **The rule flip deletes the override** (`"@inflexa-ai/no-interface": "off"`
   and its `#704` comment). The preset default takes over; no new entry.
6. **Spec deltas follow one rule:** a spec statement is corrected only where it
   names the keyword construct on a harness type ("the `AgentMeta` interface")
   or shows `interface` syntax in a code block. Contract-sense prose ("the seam
   interface", "any other host interface") and Purpose sections stay, because
   OpenSpec deltas replace requirements, not purpose text. Residuals: the
   Purpose sections of `harness-sandbox-exec` ("the `SandboxClient` interface")
   and `exec-provenance-lineage` ("the `ArtifactRegistry` interface") keep the
   generic noun, and two scenario titles keep the word because a MODIFIED
   delta cannot rename a scenario without dropping it: `harness-sandbox-exec`
   "Interface surface is the seven operations" and `harness-thread-history`
   "The interface offers no generic message insert".
7. **The release note is written in Simplified Technical English** because its
   destination is GitHub (PR description, release body); the STE rule binds
   GitHub text. The `openspec/` artifacts are not STE-bound.

## Risks / Trade-offs

- **The break is real and public**: any embedder that merges into a harness
  interface stops compiling. Nothing in-repo merges (verified), and the cli and
  bench embedders are the first consumers to re-typecheck against the change.
- **Intersection types display worse** in editor hovers and error messages
  (`ChatProvider` and the seam types). Cosmetic only.
- **`exactOptionalPropertyTypes` is off** in this line (that flag belongs to
  #705's stack below this change), so optional-member intersections behave
  exactly as interface extension here.
- **The inventory is a snapshot**: rows captured from this branch point; a
  drift between this merge and the publish is possible and acceptable — the
  note names the release line, not a moving hash.
