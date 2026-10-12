import { typescript } from "@inflexa-ai/oxlint-plugin";

// The js/recommended rule set of the plugin, written here because the pinned
// 0.7.0 exports no named copy of it: the factory applies the set to
// `**/*.{ts,tsx}` only, and the smoke script is JavaScript.
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
    // The two lifted bans have no replacement in this package. `JSON.parse`: the tests
    // round-trip PROV-JSON through parse/stringify, and zod 4.4.3 exports no schema that
    // decodes a JSON string. `regex`: `qnameSafe` substitutes a character class and the
    // browser-safety guard scans module specifiers; no builtin or parser expresses either.
    syntax: { jsonParse: false, regex: false },
    // `causeDetail` of src/verify.ts reads the message of a signing failure's cause; the cause is
    // whatever the runtime threw out of WebCrypto, so no narrower class than `Error` exists.
    instanceofErrorAllowIn: ["src/verify.ts"],
    overrides: [
        {
            files: ["**/*.{ts,tsx,js,mjs}"],
            rules: {
                // The preset sets the rule bare, which drops the `^_` escape of the
                // four ignore patterns that prov-kernel carried under the previous linter.
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
            // The kernel is a published library embedded by hosts it does not control.
            // Diagnostics are the host's concern; the kernel returns values and Results
            // and writes nothing to console.
            files: ["src/**"],
            rules: { "no-console": "error" },
        },
        {
            files: ["scripts/**/*.mjs"],
            rules: jsRecommended,
        },
    ],
});
