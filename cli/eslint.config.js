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
//
// The patched `report` additionally recognizes `._unsafeUnwrapErr()` as consuming
// its Result: the plugin's handledMethods list has `_unsafeUnwrap` but not the err
// twin, so a directly-chained `fn()._unsafeUnwrapErr()` — the standard test idiom
// for asserting an expected Err (CLAUDE.md sanctions both unsafe unwraps in tests) —
// would otherwise be a false positive. Taught here, once, rather than scattering
// per-site disables.
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
                    report: {
                        value(descriptor) {
                            const parent = descriptor.node?.parent;
                            const consumedByUnwrapErr =
                                parent?.type === "MemberExpression" &&
                                parent.property?.name === "_unsafeUnwrapErr" &&
                                parent.parent?.type === "CallExpression";
                            if (!consumedByUnwrapErr) context.report(descriptor);
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
                {
                    // NODE_ENV is not a source of truth in this codebase: our build mode is the baked
                    // `INFLEXA_BUILD_CHANNEL`, read via `env.isDevelopment` / `devCommandsEnabled`. NODE_ENV is
                    // only the deps' compile-mode axis, and scripts/build.ts --defines it FROM the channel so the
                    // two can't diverge. Banning direct reads (env.ts included) keeps that coupling the single
                    // authority. scripts/build.ts sets it via a `define["process.env.NODE_ENV"]` string key — an
                    // object property, not this `process.env.NODE_ENV` member expression — so it is unaffected.
                    // ONE sanctioned exception, disabled inline in env.ts: the test-sandbox guard, which asks
                    // "is this a `bun test` process?" — a question the channel cannot answer and NODE_ENV can.
                    selector: "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='NODE_ENV']",
                    message: "Don't read `process.env.NODE_ENV` — use `env.isDevelopment` / `devCommandsEnabled` (baked from INFLEXA_BUILD_CHANNEL). See src/lib/env.ts.",
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
        // before env.ts freezes its paths (preload.ts); env.ts itself *reads* the marker at import to
        // refuse resolving any path under an unsandboxed `bun test`; assertTestSandbox re-reads it to
        // authorize an individual destructive op (sandbox.ts); and the harness test toggles it to prove
        // the guard refuses when absent (harness.test.ts). The marker can't route through the frozen env
        // because it gates env's own derivation, and the reset lifecycle, not a value env exposes.
        // env.test.ts drives `process.env` directly to exercise the CALL-TIME readers env.ts exposes
        // (resolveModelApiKey / detectProviderEnv): their contract is to read the LIVE environment, so
        // asserting their precedence requires setting the variables — there is no frozen-env route to a
        // value that is deliberately not frozen.
        ignores: [
            "src/lib/env.ts",
            "src/lib/env.test.ts",
            "src/test_support/preload.ts",
            "src/test_support/sandbox.ts",
            "src/test_support/harness.test.ts",
        ],
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
