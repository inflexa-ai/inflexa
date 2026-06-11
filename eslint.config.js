import js from "@eslint/js";
import globals from "globals";
import solid from "eslint-plugin-solid/configs/typescript";
import tseslint from "typescript-eslint";
import neverthrowPlugin from "eslint-plugin-neverthrow";
import { defineConfig } from "eslint/config";

// Patch eslint-plugin-neverthrow for ESLint v10 — the plugin reads
// context.parserServices / context.getScope() which were moved to
// context.sourceCode.parserServices / context.sourceCode.getScope(node).
const originalRule = neverthrowPlugin.rules["must-use-result"];
const neverthrow = {
    rules: {
        "must-use-result": {
            ...originalRule,
            create(context) {
                const patched = Object.create(context, {
                    parserServices: {
                        get() {
                            return context.sourceCode.parserServices;
                        },
                    },
                    getScope: {
                        value() {
                            return context.sourceCode.getScope(context.sourceCode.ast);
                        },
                    },
                });
                return originalRule.create(patched);
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
        },
    },
    tseslint.configs.recommended,
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
]);
