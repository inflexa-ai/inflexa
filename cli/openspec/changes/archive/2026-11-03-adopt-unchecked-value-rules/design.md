# Design

## Context

See proposal.md for the motivation. The facts that shape the approach:

- `cli/tsconfig.json` sets `strict` and `noUncheckedIndexedAccess`, and includes `scripts/**/*`. It does not set `exactOptionalPropertyTypes`.
- `cli/oxlint.config.ts` turns the six rules off in its last override, under the comment `#805`. The other `off` entries of that block belong to #806 to #811 and stay.
- Measured on this branch (oxlint 1.85.0, `@inflexa-ai/oxlint-plugin` 0.8.0, TypeScript 7.0.2), with only the six `off` values removed:
  - `@inflexa-ai/no-conditional-spread`: 188 reports, 12 of them in test files. 99 sites have the shape `...(v !== undefined ? { k: v } : {})` on one value. The others test `null`, `""`, a default value, a boolean, or truthiness, or they hold a computed value, more than one key, or `&&`.
  - `typescript/no-unsafe-*`: 118 reports, 89 of them in test files. Most test sites read an untyped `JSON.parse` or `Response.json()` result.
- The rule message of `no-conditional-spread` has two parts. With the flag off, a missing key and an `undefined` key mean the same, thus the direct property is correct. When the key must be absent, build the object in a named variable and add the key inside an `if`.
- Platform facts, checked with bun on this machine: `new Headers({ a: undefined })` sends the header value `"undefined"`. `new URLSearchParams({ q: undefined })` gives `q=undefined`. `{ ...defaults, ...{ x: undefined } }` overwrites `x` with `undefined`. `JSON.stringify` drops a key whose value is `undefined`. Solid `mergeProps` skips an `undefined` value, and cli source calls no `mergeProps` or `splitProps`.
- Harness review #733 W2-W4: the harness sweep of the same rule dropped gates, and consumers that observe key presence changed. That is the defect class of this change.

## Goals / Non-Goals

**Goals:**

- The six rules report nothing, with no `off` entry, no blanket directive, and no new `as` or `!` that hides an `any`.
- Each conditional spread keeps the key set that its consumer sees, and each consumer that observes presence has a test that asserts it.
- Where one shape repeats, one abstraction replaces it (umbrella #608).

**Non-Goals:**

- Turning `exactOptionalPropertyTypes` on, or widening optional properties to `?: T | undefined` in preparation for it.
- The reports of the rules of #806 to #811. This change removes none of their sites. If a different shape prevents a new site for one of those rules, use that shape.
- A behavior change of any kind, also one that looks like an improvement.

## Decisions

### D1: `exactOptionalPropertyTypes` stays off

The issue asks for a decision. The coordinator gave one brief, with the measurements and three options, to three independent reviewers. No reviewer saw the recommendation of another.

| Option | Description |
| --- | --- |
| A | The flag stays off. The spread rule stays off with a reason comment (the literal text of issue task 1). Only the `no-unsafe-*` family turns on. |
| B | The flag stays off. The spread rule turns on (the harness precedent). Direct property where no consumer observes presence, absent key where one does. |
| C | The flag turns on. Fix its 189 type errors (148 in source, 41 in tests). The spread rule turns on. |

| Reviewer | Model | Choice |
| --- | --- | --- |
| Codex | gpt-6-sol, high reasoning | B |
| Pi | the `viv-issue-reviewer` flavor of Pi, medium | B |
| Claude reviewer | sonnet, high effort | B |
| Coordinator | opus | B |

The decision is B, by unanimous choice. No reviewer dissented. The reasons:

- A keeps a preset rule off. #608 permits no `off` preset rule except the bun-types test exception, and the done-when of #805 says that the rules of task 4 are on. The literal text of task 1 ("if no, keep the spread rule off") conflicts with both, and the reviewers resolved the conflict to the done-when.
- C costs the most and protects the least. Many of the 189 errors sit at targets that harness types with the flag off. For example, `src/modules/harness/run_deps.ts:154` assigns into the harness type `SandboxAgentDeps`. Thus cli cannot widen them, and each widening that cli can make restores the equivalence that the flag removes. The flag would also not have caught W2-W4. Those were a `"undefined"` string, an empty array, and an OTLP attribute, not an `undefined` value at an optional key.
- B matches the harness capability `type-strictness` and the documented fix of the rule. Tests control the presence-observing consumers (D2, D4).

Issue #805 asks to record the decision in the issue. The agents of this change do not write to GitHub. Thus the pull request description carries the decision and this table, and the user records it on the issue.

### D2: The fix shape of a conditional spread

Classify each site before you change it, and record the class in `notes.md` (D5). The class has two parts: the value rule and the consumer.

The value rule. The new code gives the same value as before in each case where the key was present. Where the key was absent, it gives an absent key or the value `undefined`. It never gives a different value such as `""`, `[]`, `null`, `false`, or `"undefined"`:

- `...(v !== undefined ? { k: v } : {})` and its `=== undefined` mirror become `k: v`.
- A different condition moves into the value: `k: cond ? x : undefined`, or `k: v ?? undefined` for a `null` that meant absent. Take a truthiness test on a value of type `X | undefined`, where `X` is an object or a function. It is the same as `!== undefined`, thus it becomes `k: v`. A truthiness test on a string, a number, or a boolean is different, thus it moves into the value.
- A spread that adds more than one key becomes one property for each key, with the same condition in each value. A spread of an object that can be `null` or `undefined` becomes `...value`, because a spread of `null` or `undefined` adds nothing.
- A spread that guards a computation (for example `JSON.stringify(req.body)`, or a call that can throw) keeps the guard in the value: `k: cond ? compute() : undefined`.

The consumer. A consumer observes presence when one of these is true:

- It reads `in`, `Object.keys`, `Object.entries`, `Object.values`, `Object.hasOwn`, or `hasOwnProperty` on the object, or on an object that the object spreads into.
- It spreads the object over defaults, or passes it to `Object.assign`. Then an `undefined` value overwrites the default.
- It converts the object to `Headers`, `URLSearchParams`, or `FormData`.
- It passes the object to a library or to harness code whose handling of an `undefined` key you cannot read. Treat that consumer as one that observes presence.
- A test asserts the exact key set (`toStrictEqual`, `toHaveProperty`, `not.toHaveProperty`, `in`, `Object.hasOwn`, `Object.keys`).

A consumer that only reads the property (`obj.k`, `obj.k ?? d`, destructuring with a default), or that sends the object through `JSON.stringify` (for example `c.json`), does not observe presence.

The form. Where no consumer observes presence, use the direct property of the value rule. Where a consumer observes presence, keep the key absent: build the object in a named variable and add the key inside an `if`. Sometimes the same object shape repeats at more than one site. Then one function in the module that owns the data builds the object for each site. Each caller keeps its own condition and passes the computed values. The function uses the form of the class of its consumer. Known candidates, each with its owner group of `tasks.md`:

- the package query `{ spelling, track, version }` at `src/modules/libs/store_flight.ts:121-127`, `src/modules/libs/store.ts:944-951`, and `src/server/routes/store.ts:114-119`. Home: `src/modules/libs/`. Owner: group 5. The version conditions differ (an empty specifier, a `==` prefix, a flag), thus each caller computes its version.
- the turn spend copy (`turnUsage`, `storeFailed`) at `src/modules/harness/turn.ts:205-206` and `src/server/routes/conversation.ts:641-653`. Home: `src/modules/harness/turn.ts`. Owner: group 4.
- the used-input reference with `fileId` at `src/modules/harness/prov_bridge.ts:123`, `:129`, and `:322`. Owner: group 4.
- the `fetch`/`arch`/`retry` pass-through at `src/modules/libs/store_download.ts:1262-1263` and `:1389-1393`. Owner: group 5.

A shared function obeys the cli rules: it stays in the file of its callers when they share a file, and it carries a JSDoc block when it is exported. It builds the object with `if` statements, not with a cast. No generic "drop the `undefined` keys" helper: it needs a cast or an untyped `Object.fromEntries`, and it hides which key is conditional.

Alternative rejected: one form for every site (all direct, or all `if`). All direct is the W2-W4 defect. All `if` adds a named variable and an `if` where no consumer can see the difference. The rule documents the direct form for those sites.

### D3: The fix shape of a `no-unsafe-*` report

Each report marks a value of type `any`. Type the value where it enters, not where it is read:

- External data in source (a file, an HTTP body, a subprocess output) goes through a schema parse at the boundary: `JSON.parseWith` (`src/extensions/json.ext.ts`) or the schema that the module already holds. The schema accepts each input that the current code accepts, and it rejects no input that the current code tolerates (#733 W1, W6, L2). A parse failure takes the existing failure path of the module (a `Result` error, a skip, or the existing default).
- A library value typed `any` gets an explicit type at the boundary: `unknown` with a narrowing, a type argument (`new Map<K, V>()`), `Array.from({ length }, ...)` in place of `new Array(n).fill(x)`, or the published type of the value (for example the WebCrypto `JsonWebKey`).
- In a test, parse a JSON result with the schema that the production reader uses, when one exists. Otherwise, declare the value `unknown`. Then assert on it with a matcher that reads the whole value (`toEqual`, `toMatchObject`), or parse it with a small schema in the test. If the same parse shape repeats across test files, one helper in `src/test_support/` replaces it.
- A mock or a spy takes the type of the function that it replaces (`spyOn` with its type parameters, or a typed function).

No `as` cast, non-null `!`, `any`, or directive without a recorded reason hides an `any`. If a site has no other fix, it keeps one reasoned `oxlint-disable-next-line <rule> -- <reason>` directive, and `notes.md` names the site and the reason. Each assertion of a test stays: a fix that removes or loosens an assertion is a defect.

Alternative rejected: a local `as T` at each read. It moves the `any` into an unchecked cast, which #806 then removes again.

### D4: The tests of the presence-observing consumers

Take each site that D2 classifies as presence-observing. A test of the consumer module asserts the absent key for the absent case. It also asserts the key and the value for the present case. Use `Object.hasOwn`, `in`, or `not.toHaveProperty`. Do not use `toEqual` for this purpose, because `toEqual` ignores a key whose value is `undefined`. An existing test counts only when it asserts the absent case and the present case for the same site. Otherwise, add the missing case. Each new test goes into the `test/` folder of its module (`test-placement` capability). One exception applies: a test cannot import the code, and the type of the object rejects an `undefined` value at the key. Then `bun run typecheck` is the check. The `OPENTUI_LIBC` define of `scripts/build.ts` is such a site.

For a direct-form site whose object a test already compares with `toStrictEqual`, the test can fail because the object now holds an `undefined` key. That failure shows that the consumer observes presence through the test. Then the site takes the absent-key form. Do not change the matcher to `toEqual`.

### D5: `notes.md` records the classification

`notes.md` in the change folder holds one row for each spread site: the site, the condition shape, the consumer with its `file:line`, the presence class (observes, does not observe, unknown and thus observes) with the evidence, the form, and the test that covers it. It also lists each `no-unsafe-*` site that keeps a directive (D3), and each shared function that D2 adds. The reviewers read it against the diff.

### D6: The order and the mid-state

The six `off` entries leave `oxlint.config.ts` first. From then on the full lint fails until the last fix group lands. The checkboxes of `tasks.md` are the record of progress. Each fix group runs `bun --bun oxlint <paths>` on the files that it changed, and `bun run test <files>` on the tests of those files. Only the coordinator runs the full lint, the full typecheck, and the full suite, at the close-out.

## Risks / Trade-offs

- [A direct property reaches a consumer that observes presence (W2-W4)] → D2 classifies each site against its consumer before the edit. An unknown consumer counts as observing. D4 adds a test for each observing consumer. The reviewers compare `notes.md` with the diff.
- [A truthiness condition hides a value that the direct form changes, for example `""` or `0`] → the value rule of D2 moves each such condition into the value.
- [A test loses strength in a `no-unsafe-*` fix] → D3 keeps each assertion, and a schema parse makes a test stronger, not weaker.
- [A new shared function grows into a general helper] → D2 permits one function for one repeated shape. It lives in the module that owns the data, and it uses `if` statements.
- [The tsgolint process of oxlint can panic one time in a run (seen in the review of #610)] → run the lint again one time. A second failure is a real failure.

## Migration Plan

No data, API, or wire format changes. Rollback is the branch.
