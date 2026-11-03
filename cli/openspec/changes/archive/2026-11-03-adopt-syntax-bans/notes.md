# Notes

The implementors fill this file. Each group adds its rows.

## Measurements

Start (design Context, oxlint 1.85.0, the real config with the three switches on):

| Ban | Total | Source | Tests |
| --- | --- | --- | --- |
| regex | 300 | 110 (6 in `oxlint.config.ts`) | 190 |
| jsonParse | 91 | 21 | 70 |
| timers | 95 | 39 | 56 |

Live run after task 1.1 (`bun --bun oxlint -f unix src scripts`, the six regex literals of `oxlint.config.ts` carry a directive): 480 reports.

| Ban | Total | Source | Tests |
| --- | --- | --- | --- |
| regex | 294 | 104 | 190 |
| jsonParse | 91 | 21 | 70 |
| timers | 95 | 39 | 56 |

Live run after group 2: 420 reports.

| Ban | Total | Source | Tests |
| --- | --- | --- | --- |
| regex | 294 | 104 | 190 |
| jsonParse | 70 | 0 | 70 |
| timers | 56 | 0 | 56 |

Live run after group 3 (task 3.1): 316 reports.

| Ban | Total | Source | Tests |
| --- | --- | --- | --- |
| regex | 190 | 0 | 190 |
| jsonParse | 70 | 0 | 70 |
| timers | 56 | 0 | 56 |

Live run after group 4 (task 4.1): 190 reports, all `regex` in test files.

| Ban | Total | Source | Tests |
| --- | --- | --- | --- |
| regex | 190 | 0 | 190 |
| jsonParse | 0 | 0 | 0 |
| timers | 0 | 0 | 0 |

Live run after group 6 (task 6.1): 0 reports from `bun --bun oxlint src scripts oxlint.config.ts`. The start of group 6 was 113 regex reports in 28 test files outside `src/modules/`.

Each source regex site is gone through a string method, a helper of `src/lib/text.ts`, or zod, or it is a named pattern with one directive (below). The five entity patterns of `geo.ts` became one pattern.

The 21 source `JSON.parse` sites: 20 replaced, and the one in `src/extensions/json.ext.ts` is the primitive (one directive). The 39 source timer sites are replaced, and the two raw calls of `src/lib/timer.ts` carry one directive each.

## Directives

Each row is a directive of the three bans (`// oxlint-disable-next-line eslint-js/no-restricted-syntax -- <intent>`).

| File | Line | Ban | Intent |
| --- | --- | --- | --- |
| `oxlint.config.ts` | 81 | regex | The `/(^|\/)db\//` pattern is the argument of `sourceSelector`. An esquery attribute selector takes a regex, and `RegExp.toString()` gives its escaped text. A string method cannot test the source of an import inside a selector. |
| `oxlint.config.ts` | 86 | regex | The `/(^|\/)server\//` pattern. Same reason. |
| `oxlint.config.ts` | 91 | regex | The `/(^|\/)lib\/bus(\.ts)?$/` pattern. Same reason. |
| `oxlint.config.ts` | 96 | regex | The harness allowlist pattern with a lookahead. Same reason, and a selector has no string-method form of a lookahead. |
| `oxlint.config.ts` | 104 | regex | The `modules/` allowlist pattern with a lookahead. Same reason. |
| `oxlint.config.ts` | 115 | regex | `hexColor`, the whole-value hex color pattern that `literalSelector` turns into a selector. Same reason. |
| `src/extensions/json.ext.ts` | 30 | jsonParse | The one `JSON.parse` of the tree. `JSON.parseResult` is the one place that turns text into a value. Each caller states its schema, and `parseResult` gives it to `safeParse`. |
| `src/lib/timer.ts` | 9 | timers | The `setTimeout` of `runAfter`. This module is the one owner of a timer handle, and it reads the global at call time so `jest.useFakeTimers()` controls it. |
| `src/lib/timer.ts` | 19 | timers | The `setInterval` of `runEvery`. Same reason. |
| `src/lib/test/text.test.ts` | 7, 9, 11, 13, 15, 17 | regex | Each reference pattern is the pattern that a helper of `src/lib/text.ts` replaces (`\/+$`, `[/\\]+$`, `^\d+$`, `\s`, `\s+`, `\s+` with `g`). The test holds the helper to the exact result of the pattern. No string method can be the oracle of itself. |

Group 3 (task 3.1), each regex literal that stays in the source:

| File | Line | Ban | Intent |
| --- | --- | --- | --- |
| `scripts/build.ts` | 43 | regex | `ENV_DOT_ACCESS`: each `process.env.NAME` in the source text of `env.ts`. A scan for a source grammar. |
| `scripts/build.ts` | 434 | regex | `UNRESOLVED_LICENSE_NAME`: a placeholder license name, a case-insensitive alternation with white space and `c`/`s` variants, the same grammar as `sbom_common.py`. |
| `scripts/build.ts` | 565 | regex | The pinned Hugging Face file URL. A `URL` parse changes the match (userinfo, port, host case, percent forms) and is longer, and the hex test has no string method. |
| `src/lib/log.ts` | 14 | regex | `LOG_FILE_PATTERN`: the date of a log file name with an optional rolled number. A string form (`startsWith`, `endsWith`, `split(".")`, fixed-width ASCII digit parts) is exact, and it is longer. |
| `src/modules/embedding/local-provider.ts` | 762 | regex | `INCOMPATIBLE_LIBC`: the loader line for a missing glibc, libstdc++, or C++ ABI symbol. |
| `src/modules/embedding/local-provider.ts` | 878 | regex | `PS_PID_PPID_COMMAND`: the pid, ppid, and command columns of a `ps` line. A string form is longer and does not hold the edges of `.` and `$`. |
| `src/modules/geo/geo.ts` | 187 | regex | `HTML_ENTITY`: the five predefined entities and the numeric apostrophe forms, in any letter case. One pass decodes each entity once. |
| `src/modules/geo/geo.ts` | 224 | regex | `HREF_ATTRIBUTE`: each `href` attribute of an HTML autoindex, with a quote of either kind. |
| `src/server/routes/files.ts` | 278 | regex | `RANGE_HEADER`: one `bytes=<first>-<last>` range of an HTTP `Range` header, unit in any case, each number empty or ASCII digits. A string form (`trim`, lowercase, `startsWith("bytes=")`, a `split("-")` into exactly two parts that are each empty or ASCII digits) is exact, and it is longer. |
| `src/modules/infra/proxy_config.ts` | 130 | regex | `REMOTE_MANAGEMENT_LINE`: the `remote-management:` key at a line start (`m`), and the replace swaps that line. `m` and `.` honor `\n`, `\r`, U+2028, and U+2029. A string form must find each line start and end by those four and rebuild the text, and it is longer. |
| `src/modules/infra/proxy_config.ts` | 133 | regex | `SECRET_KEY_LINE`: an indented `secret-key:` line, with its indent and key name captured for the replace. `\s+` runs over any white space, a line break included. A string form must scan for a line start, a white space run, and the key, and rebuild the text, and it is longer. |
| `src/modules/infra/setup_answers.ts` | 544 | regex | `BLOCK_MAPPING_ENTRY`: one YAML block mapping line. A YAML rule. |
| `src/modules/infra/setup_answers.ts` | 548 | regex | `BLOCK_SCALAR_HEADER`: a YAML block scalar header. A YAML rule. |
| `src/modules/infra/setup_answers.ts` | 570 | regex | `TRAILING_COMMENT`: a YAML comment after white space. A YAML rule. |
| `src/modules/infra/setup_answers.ts` | 574 | regex | `FLOW_MAPPING`: the inside of a one-line YAML flow mapping. |
| `src/modules/infra/setup.ts` | 2662 | regex | `urlPattern`: each URL in a line that the login container prints, to the first white space, quote, or angle bracket. A string form needs a scan loop with a stop set, and it is longer. |
| `src/modules/infra/setup.ts` | 2664 | regex | `sshPattern`: the `ssh -i` or `ssh -L` tunnel command in the same output, to the last digit of the line. A string form must try each `ssh` of the line, skip the white space, test the flag, and look back for the last digit, and it is longer. |
| `src/modules/proxy/models.ts` | 109 | regex | `API_KEYS_FIRST_ENTRY`: the first quoted entry of `api-keys:` in the proxy config (`m`): white space that holds a line break, a dash, and a quoted value with no inner quote. A string form must find the line start, check the line break, and read to the closing quote, and it is longer. |
| `src/modules/update/latest.ts` | 33 | regex | `VERSION_PREFIX`: the three numbers of a release version at the start of a tag. A string form (drop a `v`, `split(".")`, two digit-only parts, a leading digit run of the third) is exact, and it is longer. |

Group 5 (task 5.1), each regex literal that stays in a test file or in the test support:

| File | Line | Ban | Intent |
| --- | --- | --- | --- |
| `src/test_support/text_shapes.ts` | 44 | regex | `literalWithHoles`: the one builder of a pattern from escaped literal parts and holes. A PROV-N statement of a test has a `\w+` hole in the middle, and no string method matches a character class there. |
| `src/modules/infra/test/setup.test.ts` | 2516 | regex | `ANSWER_TABLE_SOURCE`: cuts the `ANSWER_QUESTIONS` object literal out of the source text of `setup_answers.ts`, with a lazy scan to its closing line. |
| `src/modules/infra/test/setup.test.ts` | 2518 | regex | `ANSWER_ENTRY_LINE`: one entry line of that table (key, optional quotes, body), with `gm`. |
| `src/modules/prov/test/lineage.test.ts` | 643 | regex | `DOT_EDGE_LINE`: one DOT edge line with two quoted names with escapes and the label. The test parses the renderer output. |
| `src/modules/prov/test/lineage.test.ts` | 645 | regex | `MERMAID_NODE_START`: tells a Mermaid node statement from an edge line. |
| `src/modules/prov/test/lineage.test.ts` | 647 | regex | `MERMAID_NODE_LINE`: the whole grammar of a Mermaid node statement. |
| `src/modules/prov/test/lineage.test.ts` | 649 | regex | `MERMAID_EDGE_LINE`: the whole grammar of a Mermaid edge line. |
| `src/modules/prov/test/lineage.test.ts` | 651 | regex | `MERMAID_LABEL`: each quoted Mermaid label with its bracket pair, anywhere in a line (`g`). |

The string forms named in the rows of `files.ts`, `latest.ts`, and `log.ts` were compared with their patterns on 400000 random texts per pattern and on 300000 structured texts (valid shapes with one edit), with no difference. The other rows state the steps of a string form without a claim of exactness.

The group 5 agent stopped on a network error after its last edit. The coordinator measured the state: `bun --bun oxlint` reports no site under `src/modules`, `bun run typecheck` exits 0, and the 28 changed module test files and `src/test_support/test/text_shapes.test.ts` pass (1109 pass, 0 fail, 4139 `expect()` calls).

Group 6 (task 6.1), each regex literal that stays in a test file outside `src/modules/`:

| File | Line | Ban | Intent |
| --- | --- | --- | --- |
| `src/tui/layout/test/sidebar.render.test.tsx` | 56 | regex | `TRAILING_NON_ALPHANUMERIC`: strips the rail chrome (border, scroll thumb) after a figure, so the test reads where the figure ends. A letter or a number of any script is a Unicode property (`\p{L}`, `\p{N}`), and no string method or builtin tests one. |

A directive of a different rule that group 2 added:

| File | Line | Rule | Intent |
| --- | --- | --- | --- |
| `src/tui/components/list_core.tsx` | 315 | solid/reactivity | `runAfter(0, attemptSeededScroll)` passes a function that reads the viewport signal. The rule flags it because `runAfter` is not a timer call that it knows (`setTimeout` was). The poll reads once per timer run outside a tracking scope on purpose. |

## Behavior differences

Design D7:

- `scripts/build.ts`: a malformed or mismatched `package.json` ends the build with exit code 1, and `readManifest` prints `<path>: <message>`. Today an uncaught `SyntaxError` or `ZodError` ends it with exit code 1 and a stack. (Group 2, done.)
- A stderr classifier with `/i` becomes a lowercase compare (`mentionsAny` of `src/lib/text.ts`, `includes` for the one-phrase sites). (Group 3, done.) The sites are `src/modules/infra/postgres.ts` (three lists), `src/modules/sbom/sbom.ts` (the image list and the `cat:` line), `src/modules/embedding/api_models.ts` (`embed` in a model id), and `scripts/build.ts` (the license and notice file name prefixes). Each agrees with the pattern on ASCII text. The two forms differ only where a phrase holds a letter that a non-ASCII character lowercases to, for example the Kelvin sign for `k`. The phrases `no such object`, `could not connect`, `permission denied`, and the others hold such a letter in a few words, and a runtime does not print the Kelvin sign.

Found in groups 1 and 2. None changes a result that a test or a caller can see.

| Site | Difference | Reason it is invisible |
| --- | --- | --- |
| `scripts/build.ts` (`@opentui/core` manifest) | Read with `readFileSync` and not `await Bun.file().text()`. | A missing file still throws `ENOENT` at the same point. The build has no other task running at that read. |
| `src/modules/auth/whoami.ts` `decodeIdTokenClaims` | The `try/catch` is removed, and `JSON.parseWith` replaces it. | `Buffer.from(string, "base64url").toString("utf8")` does not throw for a string, and `parseWith` gives `null` for a parse error, a mismatch, and a throw of the schema. |
| `src/modules/infra/setup.ts` `isModelNotFoundBody` | The `try/catch` is removed, and `JSON.parseWith` replaces it. | The code after the parse reads `z.record(z.string(), z.unknown())` results and cannot throw. |
| `src/test_support/fake_client.ts`, `src/test_support/request_body.ts` | A body that is not JSON throws `Error("malformed JSON: SyntaxError: ...")` (`parsedJson`), not a bare `SyntaxError`. A mismatch still throws the `ZodError`. | Test-only helpers. No test feeds a malformed body to them. |
| `withinDeadline` (`search_index.ts`, `runtime.ts`, `otel.ts`) | The settled path passes one more microtask (`promise.then`). The timer also clears when `promise` rejects, and in `otel.ts` when the race settles. | `runtime.ts` and `otel.ts` give promises that never reject. The one extra tick is before a read that already follows the wait. The `otel.ts` timer was unref'd and pending, and its clear has no visible effect (design D3). |
| `src/modules/libs/store_download.ts` `readManifest` (line of the old `JSON.parse`) | For a `mismatch` the `cause` is the `ZodError`. | `z.unknown()` never gives a `mismatch`. The branch exists for the type only. |

Found in group 3. None changes a result that a test or a caller can see. (The `cat:` line scan of `src/modules/sbom/sbom.ts` splits on `\n`, `\r`, U+2028, and U+2029 as the pattern did, thus it has no difference, and `src/modules/sbom/test/sbom.test.ts` pins it.)

| Site | Difference | Reason it is invisible |
| --- | --- | --- |
| `src/modules/geo/geo.ts` `decodeHtmlEntities` | One pass with one pattern replaces five sequential passes. | The sequential order (`&amp;` last) made each entity decode once, which is what one pass does. A new test pins `&amp;lt;`, `&amp;amp;`, and the letter cases. |
| `src/modules/geo/geo.ts` `parseByteSize` | A string scan replaces the pattern. | A new test pins the edges (a point with no digit, a second point, Unicode white space, a non-ASCII digit, the Kelvin sign) and the results equal the old pattern on each of them. |
| `src/server/routes/files.ts` `attachment` | `[...name]` walks code points, as the `u` flag did. | Same unit as before, thus the same underscores for a character beyond the BMP. |
| `src/modules/prov/lineage.ts` `idOf` | `split("")` walks UTF-16 units, as the pattern without `u` did. | Same unit as before. |

Found in group 4. None changes a result that a test can see.

| Site | Difference | Reason it is invisible |
| --- | --- | --- |
| `src/lib/test/download.test.ts`, `src/lib/test/shutdown.test.ts` | The local `sleep` helper is removed, and each call is `Promise.sleep`. | The helper only forwarded to the timer. The test preload loads the extensions, so the comment that the test process never loads them was not true. |

Found in group 6. A `not.` assertion may match more than its pattern (design D5), and this one does:

| Site | Difference | Reason it is permitted |
| --- | --- | --- |
| `src/tui/test/switch_analysis_picker.render.test.tsx` | `not.toMatch(/\b\d+[dhm] ago\b/)` is `hasNumberBefore(row, "d ago")` and the same for `h` and `m`. It has no word boundary at each end. | It matches each text that the pattern matched, and more. |

Each other replacement of group 6 gives the result of its pattern on each text. A random-text comparison (400000 strings over an alphabet of the characters of the patterns) of the local helpers with their patterns found no difference, except the `ago` case above.

Boundaries that keep their exact outcome (design D2): `src/modules/refs/store.ts` `readReceipt` and `src/modules/libs/store_download.ts` `readStoreReceipt` read the file inside the `try`, use `JSON.parseResult` with `z.unknown()`, and then call their own receipt parser. A malformed receipt gives `{ exists: true }` with no `receipt` key, and a valid JSON of the wrong shape still gives `receipt: undefined` as before.

Malformed-text tests: the boundaries of D2 each have one, except the setup checkpoint (`readSetupState`). The test "a record that is not JSON is ignored, and the completing run deletes it" was added to `src/modules/infra/test/setup.test.ts`.

## Test strength

The count of `expect(` in the source text of each changed test file.

| File | Before | After |
| --- | --- | --- |
| `src/extensions/test/extensions.test.ts` | 79 | 88 |
| `src/modules/infra/test/setup.test.ts` | 397 | 399 |

Group 3 added cases to these test files (design D4, an edge with no test before an edit):

| File | Before | After |
| --- | --- | --- |
| `src/modules/geo/test/geo.test.ts` | 79 | 88 |
| `src/modules/harness/dev/test/status.test.ts` | 9 | 13 |
| `src/modules/analysis/test/analysis.test.ts` | 58 | 63 |
| `src/modules/infra/test/setup_answers.test.ts` | 269 | 271 |
| `src/server/routes/test/artifacts.test.ts` | 63 | 67 |
| `src/modules/infra/test/setup.test.ts` | 399 | 402 |

New test files (no earlier count): `src/lib/test/timer.test.ts` 15, `src/lib/test/text.test.ts` 14 (40 after group 3, which added the cases of the new helpers), `src/test_support/test/json.test.ts` 4.

The `Promise.sleep` test moved from a real clock (one `expect`, a wall-time bound of 15 ms) to fake timers (two `expect` calls: not before the delay, and after it).

Group 4 (task 4.1) changed only the JSON and timer sites of each file below. No file adds or removes an `expect` call, thus the count after equals the count before.

| File | Before | After |
| --- | --- | --- |
| `src/cli/test/agent_policy_tree.test.ts` | 11 | 11 |
| `src/cli/test/gen_docs.test.ts` | 23 | 23 |
| `src/client/commands/test/server.test.ts` | 41 | 41 |
| `src/client/commands/test/store.test.ts` | 3 | 3 |
| `src/lib/test/config.test.ts` | 52 | 52 |
| `src/lib/test/container.test.ts` | 55 | 55 |
| `src/lib/test/download.test.ts` | 27 | 27 |
| `src/lib/test/env.test.ts` | 77 | 77 |
| `src/lib/test/shutdown.test.ts` | 19 | 19 |
| `src/modules/analysis/test/analysis.test.ts` | 63 | 63 |
| `src/modules/harness/test/config.test.ts` | 89 | 89 |
| `src/modules/harness/test/inflexa_tool.test.ts` | 137 | 137 |
| `src/modules/harness/test/prov_bridge.test.ts` | 149 | 149 |
| `src/modules/infra/test/setup.test.ts` | 402 | 402 |
| `src/modules/libs/test/composition.test.ts` | 181 | 181 |
| `src/modules/libs/test/packages.test.ts` | 10 | 10 |
| `src/modules/libs/test/store_download.test.ts` | 65 | 65 |
| `src/modules/libs/test/store_flight.test.ts` | 102 | 102 |
| `src/modules/prov/test/export.test.ts` | 12 | 12 |
| `src/modules/prov/test/kernel_compat.test.ts` | 13 | 13 |
| `src/modules/prov/test/lineage.test.ts` | 187 | 187 |
| `src/modules/prov/test/prov.test.ts` | 213 | 213 |
| `src/modules/prov/test/prov_report.test.ts` | 58 | 58 |
| `src/modules/refs/test/commands.test.ts` | 167 | 167 |
| `src/modules/refs/test/store.test.ts` | 129 | 129 |
| `src/server/routes/test/fs.test.ts` | 365 | 365 |
| `src/server/routes/test/machine.test.ts` | 198 | 198 |
| `src/server/routes/test/provenance.test.ts` | 29 | 29 |
| `src/server/routes/test/runs.test.ts` | 230 | 230 |
| `src/tui/components/dialog/test/dialog_host.render.test.tsx` | 67 | 67 |
| `src/tui/components/dialog/test/file_picker.render.test.tsx` | 84 | 84 |
| `src/tui/components/dialog/test/select_dialog.render.test.tsx` | 9 | 9 |
| `src/tui/components/dialog/test/usage_dialog.render.test.tsx` | 40 | 40 |
| `src/tui/components/test/ask_prompt.render.test.tsx` | 56 | 56 |
| `src/tui/components/test/list_primitives.render.test.tsx` | 121 | 121 |
| `src/tui/components/test/pause_prompt.render.test.tsx` | 16 | 16 |
| `src/tui/components/test/presentation_block.render.test.tsx` | 4 | 4 |
| `src/tui/components/test/tool_block.render.test.tsx` | 35 | 35 |
| `src/tui/hooks/test/boot.test.ts` | 71 | 71 |
| `src/tui/hooks/test/conversation.interrupt_retract.test.ts` | 121 | 121 |
| `src/tui/hooks/test/conversation.render.test.tsx` | 3 | 3 |
| `src/tui/hooks/test/conversation.test.ts` | 341 | 341 |
| `src/tui/hooks/test/farm_heal.test.ts` | 13 | 13 |
| `src/tui/hooks/test/report_children.test.ts` | 11 | 11 |
| `src/tui/hooks/test/sidebar_live.test.ts` | 211 | 211 |
| `src/tui/hooks/test/thread.test.ts` | 108 | 108 |
| `src/tui/layout/test/activity_panel.render.test.tsx` | 83 | 83 |
| `src/tui/layout/test/design_gallery_usage.render.test.tsx` | 4 | 4 |
| `src/tui/layout/test/message_block.test.tsx` | 34 | 34 |
| `src/tui/layout/test/run_card_settle.render.test.tsx` | 33 | 33 |
| `src/tui/layout/test/sidebar.render.test.tsx` | 228 | 228 |
| `src/tui/test/app_activity_panel.render.test.tsx` | 52 | 52 |
| `src/tui/test/app_config.render.test.tsx` | 57 | 57 |
| `src/tui/test/commands.test.ts` | 277 | 277 |
| `src/tui/test/diff_contrast.render.test.tsx` | 11 | 11 |
| `src/tui/test/input_focused_contrast.render.test.tsx` | 16 | 16 |
| `src/tui/test/keymap_chord_uniqueness.render.test.tsx` | 6 | 6 |
| `src/tui/test/keymap_interrupt_retract.render.test.tsx` | 42 | 42 |
| `src/tui/test/keymap_scroll.render.test.tsx` | 29 | 29 |
| `src/tui/test/keymap_selection.render.test.tsx` | 19 | 19 |
| `src/tui/test/model_picker.render.test.tsx` | 52 | 52 |
| `src/tui/test/remove_inputs_dialog.render.test.tsx` | 14 | 14 |
| `src/tui/test/switch_analysis_picker.render.test.tsx` | 22 | 22 |
| `src/tui/test/theme_contrast.render.test.tsx` | 13 | 13 |
| `src/tui/test/theme_picker.render.test.tsx` | 15 | 15 |

Group 5 (task 5.1), the module test files with a regex report, from `HEAD` to the working tree (the counts include the group 4 edits of the same files):

| File | Before | After |
| --- | --- | --- |
| `src/modules/analysis/test/analysis.test.ts` | 58 | 64 |
| `src/modules/geo/test/download.test.ts` | 38 | 38 |
| `src/modules/geo/test/geo.test.ts` | 79 | 88 |
| `src/modules/harness/test/inflexa_tool.test.ts` | 137 | 137 |
| `src/modules/harness/test/plan_intake.test.ts` | 38 | 40 |
| `src/modules/harness/test/runtime.test.ts` | 170 | 170 |
| `src/modules/infra/test/compose.test.ts` | 114 | 116 |
| `src/modules/infra/test/postgres.test.ts` | 74 | 74 |
| `src/modules/infra/test/proxy_config.test.ts` | 47 | 49 |
| `src/modules/infra/test/searxng_config.test.ts` | 25 | 27 |
| `src/modules/infra/test/setup.test.ts` | 397 | 402 |
| `src/modules/libs/test/composition.test.ts` | 181 | 181 |
| `src/modules/libs/test/images.test.ts` | 19 | 23 |
| `src/modules/libs/test/packages.test.ts` | 10 | 10 |
| `src/modules/libs/test/store_flight.test.ts` | 102 | 102 |
| `src/modules/prov/test/lineage.test.ts` | 187 | 187 |
| `src/modules/prov/test/prov.test.ts` | 213 | 213 |
| `src/modules/prov/test/prov_report.test.ts` | 58 | 58 |
| `src/modules/refs/test/commands.test.ts` | 167 | 167 |

Group 6 (task 6.1), the test files outside `src/modules/` with a regex report, from `HEAD` to the working tree (the counts include the group 4 edits of the same files):

| File | Before | After |
| --- | --- | --- |
| `src/cli/test/cli.test.ts` | 52 | 52 |
| `src/cli/test/gen_docs.test.ts` | 23 | 23 |
| `src/cli/test/usage_command.test.ts` | 41 | 41 |
| `src/client/commands/test/gui.test.ts` | 15 | 15 |
| `src/db/test/primary_migrations.test.ts` | 60 | 60 |
| `src/lib/test/design_system.contrast.test.ts` |  4 |  4 |
| `src/lib/test/design_system.test.ts` |  7 |  7 |
| `src/lib/test/shutdown.test.ts` | 19 | 19 |
| `src/server/routes/test/browser_session.test.ts` | 42 | 42 |
| `src/server/routes/test/files.test.ts` |      100 |      100 |
| `src/server/routes/test/machine.test.ts` |      198 |      198 |
| `src/server/routes/test/report_pages.test.ts` | 69 | 69 |
| `src/server/routes/test/usage.test.ts` |      101 |      101 |
| `src/server/test/browser_session.test.ts` | 20 | 20 |
| `src/server/test/report_page_grants.test.ts` | 28 | 28 |
| `src/tui/components/dialog/test/file_picker.render.test.tsx` | 84 | 84 |
| `src/tui/components/dialog/test/usage_dialog.test.ts` | 25 | 25 |
| `src/tui/components/test/compaction_block.render.test.tsx` | 14 | 14 |
| `src/tui/components/test/list_primitives.render.test.tsx` |      121 |      122 |
| `src/tui/components/test/run_block.render.test.tsx` | 87 | 87 |
| `src/tui/components/test/tool_block.render.test.tsx` | 35 | 35 |
| `src/tui/hooks/test/thread.test.ts` |      108 |      108 |
| `src/tui/layout/test/activity_panel.render.test.tsx` | 83 | 83 |
| `src/tui/layout/test/run_card_settle.render.test.tsx` | 33 | 33 |
| `src/tui/layout/test/sidebar.render.test.tsx` |      228 |      228 |
| `src/tui/test/diff_contrast.render.test.tsx` | 11 | 11 |
| `src/tui/test/remove_inputs_dialog.render.test.tsx` | 14 | 14 |
| `src/tui/test/switch_analysis_picker.render.test.tsx` | 22 | 22 |
| `src/test_support/test/text_shapes.test.ts` (new file in group 5) | 17 | 49 |

`list_primitives.render.test.tsx` gains one `expect(` because the meta-line test now asserts the text and the indent in two calls.

Correction round 1 (review findings R3 to R7, R9), the files that this round changed:

| File | Before | After |
| --- | --- | --- |
| `src/lib/test/shutdown.test.ts` | 19 | 19 |
| `src/tui/components/dialog/test/usage_dialog.test.ts` | 25 | 25 |
| `src/test_support/test/text_shapes.test.ts` | 49 | 55 |
| `src/modules/prov/test/prov_report.test.ts` | 58 | 58 |
| `src/tui/test/switch_analysis_picker.render.test.tsx` | 22 | 22 |
| `src/modules/infra/test/proxy_config.test.ts` | 49 | 64 |
| `src/modules/harness/test/model_listing.test.ts` | 99 | 111 |
| `src/modules/sbom/test/sbom.test.ts` (new) | 0 | 12 |
| `src/modules/infra/test/credential_state.test.ts` (new) | 0 | 5 |

`countMatches` is gone. `countOccurrences` takes a `string` or a `RegExp`, and the two `prov_report.test.ts` calls keep their counts (4 and 2). `text_shapes.test.ts` lost the 2 `expect(` calls of the `countMatches` test and gained 8 (a pattern with a hole, two adjacent matches, no match).

`sbom.test.ts` and `credential_state.test.ts` reach `readImageSbom` (through `sbomAction`) and `readCredentialVerdict` with no new injection. Each test points the `bin` of `runtimes.docker` at a fake script, selects `docker` in the config of the test sandbox, and restores both in `afterEach`.

## Close-out

- `bun run lint` in `cli/`: exit 0, no report.
- `bun run typecheck`: exit 0.
- `bun run test` (the full suite, one run): 4846 pass, 2 skip, 0 fail, 17706 `expect()` calls, 4848 tests across 234 files.
- The census of `eslint-js/no-restricted-syntax` directives: 45 under `cli/src`, `cli/scripts`, and `cli/oxlint.config.ts`. Each is an `oxlint-disable-next-line` with a reason. Each one that this change adds has a row in "Directives". The two others (`scripts/gen_docs.ts`, `src/lib/env.ts`) are the `NODE_ENV` reads that existed before.

