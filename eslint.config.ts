import js from "@eslint/js";
import globals from "globals";
import solid from "eslint-plugin-solid/configs/typescript";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig([
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
        },
    },
    tseslint.configs.recommended,
    // @ts-expect-error -- eslint-plugin-solid types lag behind eslint v10's defineConfig
    {
        files: ["**/*.{ts,tsx}"],
        ...solid,
    },
]);
