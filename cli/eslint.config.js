import js from "@eslint/js";
import globals from "globals";
import solid from "eslint-plugin-solid/configs/typescript";
import tseslint from "typescript-eslint";
import neverthrowPlugin from "eslint-plugin-neverthrow";
import { defineConfig } from "eslint/config";

// Patch eslint-plugin-neverthrow for ESLint v10 — the plugin reads
// context.parserServices / context.getScope() which were moved to
// context.sourceCode.parserServices / context.sourceCode.getScope(node).
// getScope must resolve to the visitor's current node (not the AST root) so
// the plugin's variable-reference tracker can find function-local assignments.
const originalRule = neverthrowPlugin.rules["must-use-result"];
const neverthrow = {
    rules: {
        "must-use-result": {
            ...originalRule,
            create(context) {
                let visitingNode = null;
                const patched = Object.create(context, {
                    parserServices: {
                        get() {
                            return context.sourceCode.parserServices;
                        },
                    },
                    getScope: {
                        value() {
                            return context.sourceCode.getScope(visitingNode || context.sourceCode.ast);
                        },
                    },
                });
                const visitors = originalRule.create(patched);
                const wrapped = {};
                for (const [key, fn] of Object.entries(visitors)) {
                    wrapped[key] = function (node) {
                        visitingNode = node;
                        return fn.call(this, node);
                    };
                }
                return wrapped;
            },
        },
    },
};

export default defineConfig([
    {
        ignores: ["eslint.config.js"],
    },
    {
        files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
        plugins: { js },
        extends: ["js/recommended"],
        languageOptions: { globals: globals.browser },
        rules: {
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    destructuredArrayIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                },
            ],
            "@typescript-eslint/no-floating-promises": "error",
            "@typescript-eslint/no-misused-promises": "error",
            "no-restricted-syntax": [
                "error",
                {
                    selector: "CallExpression[callee.property.name='forEach']",
                    message: "`.forEach` is banned — use a `for` / `for...of` loop instead.",
                },
            ],
        },
    },
    tseslint.configs.recommended,
    {
        // Type-aware rules need parserOptions.project, which only src/ has
        // (scripts/ is outside tsconfig's include). Standalone bun scripts
        // keep the rest of the linting.
        files: ["scripts/**/*.ts"],
        rules: {
            "@typescript-eslint/no-floating-promises": "off",
            "@typescript-eslint/no-misused-promises": "off",
        },
    },
    {
        files: ["**/*.{ts,tsx}"],
        ...solid,
    },
    {
        files: ["src/**/*.{ts,tsx}"],
        plugins: { neverthrow },
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                projectService: false,
                project: "./tsconfig.json",
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            "neverthrow/must-use-result": "error",
            // A switch over a union must handle every member OR carry a `default`. Lenient mode
            // (`considerDefaultExhaustiveForUnions: true`) treats a `default` as covering the rest, so
            // intentional default-driven switches (platform, error codes, subset handlers) pass while a
            // switch that forgets a case AND has no fallback — the shape that silently drops a new
            // variant — is caught. Complements, not replaces, the `satisfies never` idiom in exhaustive
            // switches (which the type checker enforces regardless of this rule).
            "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
        },
    },
    {
        files: ["src/**/*.{ts,tsx}"],
        // env.ts owns the canonical reads; the test-support env-sandbox plumbing is the deliberate
        // exception. The preload *sets* the XDG_* sandbox and stamps the INFLEXA_TEST_SANDBOX marker
        // before env.ts freezes its paths (preload.ts); assertTestSandbox *reads* that marker to
        // authorize every destructive env-path op — the single choke point (sandbox.ts); and the
        // harness test toggles it to prove the guard refuses when absent (harness.test.ts). The marker
        // can't route through the frozen env because it gates the reset lifecycle, not env's path
        // derivation.
        ignores: ["src/lib/env.ts", "src/test_support/preload.ts", "src/test_support/sandbox.ts", "src/test_support/harness.test.ts"],
        rules: {
            "no-restricted-properties": [
                "error",
                {
                    object: "process",
                    property: "env",
                    message: "Read environment variables through the frozen `env` object in src/lib/env.ts.",
                },
            ],
        },
    },
]);
