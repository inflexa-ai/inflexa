import { restrictedSyntax, typescript } from "@inflexa-ai/oxlint-plugin";

// The js/recommended rule set of the plugin, written here because the pinned
// 0.7.0 exports no named copy of it: the factory applies the set to
// `**/*.{ts,tsx}` only, and the harness scripts are JavaScript.
const jsRecommended = {
    "for-direction": "error",
    "no-async-promise-executor": "error",
    "no-case-declarations": "error",
    "no-compare-neg-zero": "error",
    "no-cond-assign": "error",
    "no-constant-binary-expression": "error",
    "no-constant-condition": "error",
    "no-control-regex": "error",
    "no-debugger": "error",
    "no-delete-var": "error",
    "no-dupe-else-if": "error",
    "no-duplicate-case": "error",
    "no-empty": "error",
    "no-empty-character-class": "error",
    "no-empty-pattern": "error",
    "no-empty-static-block": "error",
    "no-ex-assign": "error",
    "no-extra-boolean-cast": "error",
    "no-fallthrough": "error",
    "no-global-assign": "error",
    "no-invalid-regexp": "error",
    "no-irregular-whitespace": "error",
    "no-loss-of-precision": "error",
    "no-misleading-character-class": "error",
    "no-nonoctal-decimal-escape": "error",
    "no-prototype-builtins": "error",
    "no-regex-spaces": "error",
    "no-self-assign": "error",
    "no-shadow-restricted-names": "error",
    "no-sparse-arrays": "error",
    "no-unassigned-vars": "error",
    "no-unexpected-multiline": "error",
    "no-unsafe-finally": "error",
    "no-unsafe-optional-chaining": "error",
    "no-unused-labels": "error",
    "no-unused-private-class-members": "error",
    "no-useless-assignment": "error",
    "no-useless-backreference": "error",
    "no-useless-catch": "error",
    "no-useless-escape": "error",
    "preserve-caught-error": "error",
    "require-yield": "error",
    "use-isnan": "error",
    "valid-typeof": "error",
    "no-var": "error",
    "prefer-const": "error",
    "prefer-rest-params": "error",
    "prefer-spread": "error",
} as const;

export default typescript({
    env: { node: true },
    // The error-normalizing modules of the harness, whose job is turning an
    // arbitrary thrown value into a shaped failure:
    // - src/lib/result.ts — the Result→throw bridge (`toThrowable`/`ResultError`)
    //   that every DBOS step and tool boundary unwraps through.
    // - src/lib/logger.ts — the shipped `errorFields` of the `Logger` seam, which
    //   must classify any thrown value for a sink it does not control.
    // - src/lib/thrown.ts — the shared thrown-value reads (`errorOf`,
    //   `errorMessageOf`, `errorNameOf`) the catch sites normalize through:
    //   `errorOf` is the exact Error passthrough ("already an Error → use it as
    //   one"), and a structural lookalike must not pass, so the check must see
    //   the class.
    instanceofErrorAllowIn: ["src/lib/result.ts", "src/lib/logger.ts", "src/lib/thrown.ts"],
    // tsprov is a page-asset dependency: the report page ships its browser
    // bundle as bytes, and the manifest names it by a string specifier. An
    // API import would make the harness a provenance reader, which the
    // prov-harness-bridge contract of the cli forbids.
    restrictedImports: [
        {
            group: ["@inflexa-ai/tsprov", "@inflexa-ai/tsprov/*"],
            message: "tsprov rides the report page as a static asset only — never import its API in the harness.",
        },
    ],
    overrides: [
        {
            files: ["**/*.{ts,tsx,js,mjs}"],
            rules: {
                // The preset sets the rule bare, which drops the `^_` escape of the
                // four ignore patterns that the harness carried under the previous linter.
                "typescript/no-unused-vars": [
                    "error",
                    {
                        argsIgnorePattern: "^_",
                        destructuredArrayIgnorePattern: "^_",
                        caughtErrorsIgnorePattern: "^_",
                        varsIgnorePattern: "^_",
                    },
                ],
                // A switch over a union must handle every member OR carry a `default`.
                // Lenient mode treats a `default` as covering the rest, so an
                // intentional default-driven switch passes while a switch that forgets
                // a case and has no fallback — the shape that silently drops a new
                // variant — is caught.
                "typescript/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
            },
        },
        {
            // Diagnostics go through the injected `Logger` (`src/lib/logger.ts`), never
            // console. The harness is embedded by hosts it does not control, and a host
            // whose UI owns stdout — an alternate-screen TUI, say — discards console
            // output entirely: the write succeeds and the record is gone. That is silent
            // loss exactly when something has failed.
            files: ["src/**"],
            rules: { "no-console": "error" },
        },
        {
            // The console realization IS the console sink — writing to console is its whole
            // contract — and its test drives it by capturing those calls.
            files: ["src/lib/console-logger.ts", "src/lib/test/console-logger.test.ts"],
            rules: { "no-console": "off" },
        },
        {
            // The JSX runtime rewrites `className` to `class` without a warning.
            // A silent rewrite invites a codebase that mixes the two. Thus the
            // markup uses `class` only. An override replaces the options of
            // `eslint-js/no-restricted-syntax`, so this block restates the whole
            // `restrictedSyntax()` set beside the JSX entry — the subset form the
            // plugin's typing prescribes.
            files: ["**/*.tsx"],
            rules: {
                "eslint-js/no-restricted-syntax": [
                    "error",
                    ...Object.values(restrictedSyntax()),
                    {
                        selector: "JSXAttribute[name.name='className']",
                        message: "Use the `class` attribute, not `className`.",
                    },
                ],
            },
        },
        {
            files: ["scripts/**/*.mjs"],
            rules: jsRecommended,
        },
        {
            // bun-types types `expect().rejects.toThrow()` as `void`, so these two
            // rules report every such assertion in the tests.
            // The exemption is scoped to the two rules and the test globs only;
            // `inflexa-typecheck` still typechecks the test files.
            files: ["**/*.test.{ts,tsx}"],
            rules: {
                "typescript/await-thenable": "off",
                "typescript/no-confusing-void-expression": "off",
            },
        },
        {
            // Boundary predicates over values no parser has shaped yet. A guard over an
            // unknown-typed value is sanctioned when it IS the boundary check; these are:
            // - src/lib/unknown-array.ts — `isUnknownArray`: `Array.isArray` alone narrows
            //   `unknown` to `any[]`; this guard yields `unknown[]` so each element must
            //   narrow before use.
            // - src/lib/null-proto.ts — `isRecordOf<T>`: the generic record guard behind
            //   `nullProtoRecord`; a zod schema cannot express the caller's `T`.
            // - src/lib/result.ts — `isResult`: the runtime brand check of the neverthrow
            //   `Ok`/`Err` class identity; a schema cannot check class identity.
            // - src/providers/errors.ts — `isProviderError`: the structural narrow the
            //   provider error paths share, safe across module realms by design.
            // - src/loop/run-agent.ts — `isAskRejected`: class-or-name brand that
            //   recognizes a rejection thrown from a different module realm.
            // - src/literature/sources/pubmed.ts — `isRecord`/`isDocSumItem`: the
            //   predicates over PubMed XML parse output; the walk narrows each field.
            // - src/tools/define-tool.ts — `isToolError`/`isToolResultImage`: the boundary
            //   predicates over a tool ok value.
            // - src/tools/display/normalize-echart-spec.ts — `isRecord`: the echart option
            //   walk takes the container shape at entry and narrows each field on read.
            // - src/runtime/result-serialization.ts — the `isApplicable` of each recipe:
            //   the DBOS serialization-recipe contract declares a type predicate, and the
            //   check is the neverthrow class brand.
            // - src/state/snapshot-parse.ts — `isPlainRecord`: the stored-map walk must
            //   address the original object, because a zod record parse rebuilds the value
            //   through string-keyed assignment and a `__proto__` own key — the pin
            //   contract this module keeps — does not survive that rebuild.
            // - src/report-render/test/render.test.ts — the test-side `isRecord`: the
            //   prototype-pollution fixtures stage a `__proto__` own key, and the guard
            //   must answer on the original object, which a record parse copy drops.
            // - src/report-render/test/table-data.test.ts — the test-side `isRecord`:
            //   the fixture rows must keep an own `__proto__` key, so the guard reads the
            //   original object and takes no copy.
            // - src/report-render/test/chart-renderers.test.ts — `isRendererFunction`:
            //   the register test compares the registered renderer functions by
            //   identity, so a function check is the whole check.
            files: [
                "src/lib/unknown-array.ts",
                "src/lib/null-proto.ts",
                "src/lib/result.ts",
                "src/providers/errors.ts",
                "src/loop/run-agent.ts",
                "src/literature/sources/pubmed.ts",
                "src/tools/define-tool.ts",
                "src/tools/display/normalize-echart-spec.ts",
                "src/runtime/result-serialization.ts",
                "src/state/snapshot-parse.ts",
                "src/report-render/test/render.test.ts",
                "src/report-render/test/table-data.test.ts",
                "src/report-render/test/chart-renderers.test.ts",
            ],
            rules: { "@inflexa-ai/no-unknown-type-guards": "off" },
        },
        {
            // The `typeof` probes are the bodies of the deliberate boundary predicates
            // above, or readers of a symbol-keyed record:
            // - src/lib/null-proto.ts — the body of the ledgered `isRecordOf<T>` guard.
            // - src/literature/sources/pubmed.ts — the bodies of `isRecord`/`isDocSumItem`.
            // - src/tools/define-tool.ts — the predicate bodies plus
            //   `readToolResultImages`/`readToolCallRecord`: the record rides a unique
            //   symbol key that `JSON.stringify` omits, and a zod parse clones the value
            //   through string keys only, so every schema-shaped fix destroys the record.
            // - src/tools/display/normalize-echart-spec.ts — the body of `isRecord`.
            // - src/state/snapshot-parse.ts — the body of `isPlainRecord`, kept for the
            //   `__proto__` pin contract the `no-unknown-type-guards` zone entry states.
            // - src/providers/errors.ts — the body of `isProviderError` and the object gate
            //   of `findInCauseChain`: the structural narrow and the cause-chain walk the
            //   provider error paths share, safe across module realms by design; a
            //   null-prototype thrown link fails `instanceof Object`, so the gate is the
            //   hand object check.
            // - src/providers/ai-sdk.ts — the object gates of `apiCallErrorOf` and
            //   `streamPartFailure`: a thrown wrapper or a stream error part is whatever
            //   the SDK or the provider wire produced, and a null-prototype value fails
            //   `instanceof Object`, so the gate is the hand object check.
            // - src/report-model/reference-stamp.ts — the stamp walk: the copy must carry
            //   an own `__proto__` key of a `JSON.parse` payload (the faithful-copy pin
            //   of reference-stamp.test.ts), which a record parse rebuild drops through
            //   string-keyed assignment.
            // - src/report-model/test/reference-stamp.test.ts — the `field` walker: the
            //   suite pins an own `__proto__` key that a record parse rebuild drops, so
            //   the walker reads through the original object.
            // - src/report-model/reference-resolver.ts — the row gate of `snapshotRows`:
            //   the parse must walk the ORIGINAL row (`Object.keys` + `Reflect.get`),
            //   because the projected-column pins of validate.test.ts keep an own
            //   `__proto__` key that a record parse rebuild drops through string-keyed
            //   assignment (the same class as reference-stamp and snapshot-parse).
            files: [
                "src/lib/null-proto.ts",
                "src/literature/sources/pubmed.ts",
                "src/tools/define-tool.ts",
                "src/tools/display/normalize-echart-spec.ts",
                "src/state/snapshot-parse.ts",
                "src/providers/errors.ts",
                "src/providers/ai-sdk.ts",
                "src/report-model/reference-stamp.ts",
                "src/report-model/test/reference-stamp.test.ts",
                "src/report-model/reference-resolver.ts",
            ],
            rules: { "@inflexa-ai/no-typeof-object": "off" },
        },
        {
            // Deliberately open schemas:
            // - src/execution/run-synthesis.ts — the submit-synthesis input envelope:
            //   the candidate synthesis arrives in any shape by design, and `execute`
            //   re-parses it against RunSynthesisSchema itself, so a malformed payload
            //   becomes typed validation issues in the ok channel instead of a loop
            //   rejection at the input boundary.
            // - src/lib/unknown-containers.ts — the shared walk containers
            //   (`UnknownRecordSchema`, `UnknownArraySchema`): the unknown leaf IS the
            //   design — the walk narrows each field and each entry on read — and the
            //   record schema's shallow rebuild (a `__proto__` own key drops) is the
            //   behavior the callers pin.
            // - src/contracts/chat-frame.ts — the browser-safe generic record schema:
            //   `contracts/` imports no value from outside its own directory, so the
            //   lib walk-container helper cannot be reached, and the part schemas
            //   narrow the fields downstream.
            // - src/sandbox/sandbox-error.ts — the cause fields (`code`, `statusCode`,
            //   `response.statusCode`): the cause is an arbitrary thrown value from
            //   dockerode, the k8s client, or Node itself, and the reader guards each
            //   field with `typeof === "number"` because a sibling field of the same
            //   cause may hold a non-number (a Node error carries a string `code`).
            //   Typing one field would reject that cause whole and lose a status the
            //   reader would have found on the next field.
            // - src/tools/report-authoring/authoring-tools.ts — the permissive arm of
            //   the block payload union: a malformed block must reach `execute`, which
            //   parses it against the draft grammar and refuses `malformed-block` as
            //   typed data in the ok channel; a strict arm would turn that designed
            //   refusal into a hard input-validation error at the loop boundary.
            // - src/tools/research/generate-plan.ts — the permissive arm of the
            //   submit_plan candidate union: a malformed candidate must reach `execute`
            //   so its issues come back as structured reports, not as a parse refusal.
            // - src/memory/conversation-display-storage.ts — the header `messages`
            //   element: the envelope carries the recorder's `structuredClone` of live
            //   UI messages, not JSON text, and a live card payload holds explicit
            //   `undefined` own keys (every ordinary plan card rides
            //   `omicsType`/`omicsSubtype`), which `z.json()` refuses. The header
            //   checks presence only; `validateUIMessages` and the `dataSchemas` own
            //   the shape check.
            // - src/tools/display/show-user.ts — the `spec` member of the tool input:
            //   the model sends the input as JSON text, so `z.json()` refuses nothing
            //   more, and its recursive `$defs` reach each model backend as a `$ref`
            //   that an OpenAI-compatible backend can refuse. The presentation schema
            //   in `contracts/` keeps `z.json()` for the stored card, because no model
            //   reads it.
            files: [
                "src/execution/run-synthesis.ts",
                "src/lib/unknown-containers.ts",
                "src/contracts/chat-frame.ts",
                "src/sandbox/sandbox-error.ts",
                "src/tools/report-authoring/authoring-tools.ts",
                "src/tools/research/generate-plan.ts",
                "src/memory/conversation-display-storage.ts",
                "src/tools/display/show-user.ts",
            ],
            rules: { "@inflexa-ai/no-empty-schema": "off" },
        },
        {
            // The object gate of the shared thrown-value reads (`errorMessageOf` and
            // `errorNameOf` in src/lib/thrown.ts): `in` cannot run on a primitive, and
            // the gate must stay realm-safe and enumeration-safe — a record parse
            // rebuild answers on a copy that drops an Error's own non-enumerable
            // `message` and inherited `name`, so the read must see the original object.
            files: ["src/lib/thrown.ts"],
            rules: { "@inflexa-ai/no-typeof-object": "off" },
        },
    ],
});
