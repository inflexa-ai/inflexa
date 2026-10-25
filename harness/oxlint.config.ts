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
    // The `regex`, `jsonParse` and `timers` syntax bans lift until #708 turns
    // them back on with their fixes. `forEach` stays on.
    syntax: { regex: false, jsonParse: false, timers: false },
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
            // `eslint-js/no-restricted-syntax`, so this block repeats the still-on
            // `restrictedSyntax()` entry beside the JSX entry — the subset form the
            // plugin's typing prescribes; the lifted bans stay lifted on `.tsx`.
            files: ["**/*.tsx"],
            rules: {
                "eslint-js/no-restricted-syntax": [
                    "error",
                    restrictedSyntax({ regex: false, jsonParse: false, timers: false }).forEach,
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
            // The umbrella #607 moves the lint tool only: each preset rule with reports
            // on the pinned run stays off until the child issue named on its entry turns
            // it back on with its fixes. Rules with no reports stay on, and so do the
            // rules whose few reports the harness keeps deliberately.
            files: ["**/*.{ts,tsx,js,mjs}"],
            rules: {
                // #710 adds the missing awaits and rewrites the implied evals.
                "typescript/no-implied-eval": "off",
                "typescript/require-await": "off",
                // #709 owns each remaining rule with reports on the pinned run.
                // `await-thenable` and `no-confusing-void-expression` also report outside
                // the test globs (src/tasks/data-profile.ts,
                // src/memory/conversation-display-recorder.ts); #709 owns those sites,
                // and the test-glob block below stays as the permanent exemption.
                "@inflexa-ai/export-at-declaration": "off",
                "@inflexa-ai/no-empty-schema": "off",
                "@inflexa-ai/no-instanceof-error": "off",
                "@inflexa-ai/no-unknown-type-guards": "off",
                "typescript/await-thenable": "off",
                "typescript/no-base-to-string": "off",
                "typescript/no-confusing-void-expression": "off",
                "typescript/no-deprecated": "off",
                "typescript/no-duplicate-type-constituents": "off",
                "typescript/no-dynamic-delete": "off",
                "typescript/explicit-function-return-type": "off",
                "typescript/no-invalid-void-type": "off",
                "typescript/no-misused-spread": "off",
                "typescript/no-redundant-type-constituents": "off",
                "typescript/no-unnecessary-boolean-literal-compare": "off",
                "typescript/no-unnecessary-template-expression": "off",
                "typescript/no-unnecessary-type-arguments": "off",
                "typescript/no-unnecessary-type-conversion": "off",
                "typescript/no-unnecessary-type-parameters": "off",
                "typescript/no-useless-default-assignment": "off",
                "@inflexa-ai/no-typeof-object": "off",
                "typescript/only-throw-error": "off",
                "typescript/prefer-promise-reject-errors": "off",
                "typescript/restrict-template-expressions": "off",
                "typescript/unbound-method": "off",
                "typescript/use-unknown-in-catch-callback-variable": "off",
                // #709 owns these two as well: their reports exist only under
                // `noUncheckedIndexedAccess`, which widens an index read to
                // `T | undefined`, so they stay off until #709 takes their fixes.
                "typescript/restrict-plus-operands": "off",
                "typescript/no-unsafe-unary-minus": "off",
            },
        },
        {
            // bun-types types `expect().rejects.toThrow()` as `void`, so these two
            // rules report every such assertion in the tests (~300 false reports).
            // The exemption is scoped to the two rules and the test globs only;
            // `inflexa-typecheck` still typechecks the test files.
            files: ["**/*.test.{ts,tsx}"],
            rules: {
                "typescript/await-thenable": "off",
                "typescript/no-confusing-void-expression": "off",
            },
        },
    ],
});
