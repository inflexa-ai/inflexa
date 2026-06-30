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
        },
    },
    {
        files: ["src/**/*.{ts,tsx}"],
        // env.ts owns the canonical reads; the test preload is the one place allowed to *set* the
        // XDG_* sandbox before env.ts freezes its paths (src/test_support/preload.ts).
        ignores: ["src/lib/env.ts", "src/test_support/preload.ts"],
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
