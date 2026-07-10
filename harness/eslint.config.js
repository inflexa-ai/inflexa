import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import neverthrowPlugin from "eslint-plugin-neverthrow";
import { defineConfig } from "eslint/config";

// Patch eslint-plugin-neverthrow for ESLint v10 — the plugin reads
// context.parserServices / context.getScope() which were moved to
// context.sourceCode.parserServices / context.sourceCode.getScope(node).
// getScope must resolve to the visitor's current node (not the AST root) so
// the plugin's variable-reference tracker can find function-local assignments.
const originalRule = neverthrowPlugin.rules["must-use-result"];

// A Result that flows directly into `unwrapOrThrow(...)` IS consumed:
// it is the harness's documented Result→throw bridge for boundaries whose
// failure protocol is an exception — above all the DBOS step edge, where
// durability records a step as failed ONLY on a thrown exception (see
// src/lib/result.ts, house rule 3, and src/loop/run-step.ts `resultStep`).
// The upstream rule only recognizes member-method consumers
// (.match/.unwrapOr/._unsafeUnwrap/...), so it false-flags every bridge call
// site. Matching is by callee name, not import resolution — the name
// `unwrapOrThrow` is reserved by convention for the src/lib/result.ts helper,
// so a shadowing non-consuming function of the same name would be missed;
// that trade-off is accepted to keep this patch parser-independent.
// A Result consumed by a directly-chained `._unsafeUnwrapErr()` IS handled: the
// plugin's handledMethods list carries `_unsafeUnwrap` but not its err twin, so
// `fn()._unsafeUnwrapErr()` — the standard test idiom for asserting an expected
// Err — is a false positive. Taught here, once, rather than scattering per-site
// disables across test files.
//
// `(await fn())._unsafeUnwrapErr()` is the same idiom over a ResultAsync, and the
// `await` is a node between the call and the member access — step through it, or
// every async Err assertion still trips the rule.
function isConsumedByUnsafeUnwrapErr(node) {
    let current = node;
    while (current.parent?.type === "AwaitExpression") current = current.parent;
    const parent = current.parent;
    return parent?.type === "MemberExpression" && parent.property?.name === "_unsafeUnwrapErr" && parent.parent?.type === "CallExpression";
}

function isConsumedByUnwrapOrThrow(node) {
    let current = node;
    let parent = node.parent;
    while (parent) {
        if (
            parent.type === "CallExpression" &&
            parent.callee.type === "Identifier" &&
            parent.callee.name === "unwrapOrThrow" &&
            parent.arguments.includes(current)
        ) {
            return true;
        }
        // Step through a neverthrow transform chain (`.orElse(...)`, `.map(...)`,
        // `.mapErr(...)`, `.andThen(...)`): the receiver Result is forwarded into
        // the transform, whose own Result continues toward the eventual
        // `unwrapOrThrow` — so a chained producer is consumed just the same.
        if (
            parent.type === "MemberExpression" &&
            parent.object === current &&
            parent.property.type === "Identifier" &&
            (parent.property.name === "orElse" ||
                parent.property.name === "map" ||
                parent.property.name === "mapErr" ||
                parent.property.name === "andThen") &&
            parent.parent &&
            parent.parent.type === "CallExpression" &&
            parent.parent.callee === parent
        ) {
            current = parent.parent;
            parent = current.parent;
            continue;
        }
        // Step only through wrappers that forward the same Result value.
        if (parent.type !== "AwaitExpression" && parent.type !== "TSAsExpression" && parent.type !== "TSNonNullExpression" && parent.type !== "ChainExpression") {
            return false;
        }
        current = parent;
        parent = parent.parent;
    }
    return false;
}

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
                            if (descriptor && descriptor.node && isConsumedByUnwrapOrThrow(descriptor.node)) return;
                            if (descriptor && descriptor.node && isConsumedByUnsafeUnwrapErr(descriptor.node)) return;
                            context.report(descriptor);
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
        ignores: ["eslint.config.js", "dist/"],
    },
    {
        files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
        plugins: { js },
        extends: ["js/recommended"],
        languageOptions: { globals: globals.node },
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
        files: ["src/**/*.ts"],
        plugins: { neverthrow },
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                projectService: false,
                // The build tsconfig excludes tests from `dist/`; type-aware lint
                // rules need every linted file in the program, so eslint gets its
                // own tsconfig that includes all of src/.
                project: "./tsconfig.eslint.json",
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
]);
