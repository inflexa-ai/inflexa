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
    // `src/lib/thrown.ts` is the package's one thrown-value normalizer: it holds
    // every `instanceof Error` (message, name, abort classification) so no catch
    // block re-implements the read. `src/lib/result.ts` and `src/lib/logger.ts`
    // normalize through `isError`/`errorMessage` from it and hold no check of their own.
    instanceofErrorAllowIn: ["src/lib/thrown.ts"],
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
            // `eslint-js/no-restricted-syntax`, so this block repeats the whole
            // `restrictedSyntax()` list beside the JSX entry.
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

