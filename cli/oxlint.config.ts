import { restrictedSyntax } from "@inflexa-ai/oxlint-plugin";
import { solid } from "@inflexa-ai/oxlint-plugin-solid";

// An override that re-declares `eslint-js/no-restricted-syntax` REPLACES the
// entry list instead of extending it. Each override that adds an entry therefore
// restates the whole shared set, and spreading these constants keeps every
// restatement identical.
const sharedBans = Object.values(restrictedSyntax());

const nodeEnvBan = {
    // NODE_ENV is not a source of truth in this codebase: our build mode is the baked
    // `INFLEXA_BUILD_CHANNEL`, read via `env.isDevelopment` / `devCommandsEnabled`. NODE_ENV is
    // only the deps' compile-mode axis, and scripts/build.ts --defines it FROM the channel so the
    // two can't diverge. Banning direct reads (env.ts included) keeps that coupling the single
    // authority. scripts/build.ts sets it via a `define["process.env.NODE_ENV"]` string key — an
    // object property, not this `process.env.NODE_ENV` member expression — so it is unaffected.
    // ONE sanctioned exception, disabled inline at two sites: the test-sandbox guard read in
    // src/lib/env.ts, and the same guard in the script scripts/gen_docs.ts. It asks "is this a
    // `bun test` process?" — a question the channel cannot answer and NODE_ENV can.
    selector: "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='NODE_ENV']",
    message: "Don't read `process.env.NODE_ENV` — use `env.isDevelopment` / `devCommandsEnabled` (baked from INFLEXA_BUILD_CHANNEL). See src/lib/env.ts.",
};

const actionMessage =
    "Don't call commander's `.action()` directly in the registry — use `registerAction(command, kind, policy, handler)` from ./agent_policy.ts so every action command declares a CommandKind and an AgentPolicy.";

// Agent policy is declared ONLY in the command registry, so a bare `command.action(fn)` there would
// register an action with no policy — the exact split-brain this capability removes. Force every
// registration through `registerAction`, whose required policy parameter makes an unclassified
// command a compile error. The ban is scoped to the registry DIRECTORY (`src/cli/**`), so a future
// second registry file cannot escape it by living beside index.ts. Both the plain member call
// (`cmd.action(fn)`) and the computed-member bypass (`cmd["action"](fn)`) are banned; the
// aliased-variable form (`const a = cmd.action; a(fn)`) is not reasonably expressible in esquery and
// is left to the downstream layers (the required-policy compile error and the tree-walk test).
const actionBans = [
    {
        selector: "CallExpression[callee.property.name='action']",
        message: actionMessage,
    },
    {
        // The computed-member twin of the ban above: `cmd["action"](fn)` reaches the same method
        // through a string-literal key, which `callee.property.name` does not see (a Literal node
        // carries `.value`, not `.name`), so it needs its own selector.
        selector: "CallExpression[callee.type='MemberExpression'][callee.computed=true][callee.property.value='action']",
        message: actionMessage,
    },
];

// A selector over the source of every form that names a module: a static import, a
// re-export, `export *`, and a dynamic `import()`. `RegExp.toString()` escapes the `/` that a
// selector regex cannot hold bare. The source of `import(\`...\`)` is a `TemplateLiteral`, which has
// no `value`, so it needs its own selector over the text of its first quasi.
function sourceSelector(pattern: RegExp): string {
    const regex = pattern.toString();
    return [
        ...["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].map((node) => `${node}[source.value=${regex}]`),
        `ImportExpression[source.quasis.0.value.cooked=${regex}]`,
    ].join(", ");
}

// The cut between a client and the local server. The TUI (`src/tui/`) and the API client
// (`src/client/`) reach server state only through the HTTP API: `src/client/` sends the requests,
// and `src/api/` holds the wire types of both sides. Thus a client must not import the server
// side: the SQLite layer, the server, the bus, the harness runtime, or a module that holds state
// or does I/O.
//
// The bans are source selectors, not `no-restricted-imports` patterns: oxlint matches a `regex`
// pattern with a lookahead against nothing and reports no config error, and two of the bans below
// are allowlists that need a lookahead (a gitignore `group` glob cannot re-include a file under an
// excluded folder either). A type-only import is an `ImportDeclaration` too, so it is banned as
// well: the client gets each type of the wire from `src/api/`, never a row type of the server.
//
// The allow lists are the pure code of the client, from the boundary inventory: the harness
// contracts (`toChatFrame`, `applyChatFrame`, `checkChatPart`, the chat and part types), the pure
// profile view (`profileCaveats`, `profileDimensions`), `planToDag`, and the part readers of
// `chat_printer.ts`. The one allowed module that does I/O is `prov/verify_file.ts`: it reads only an
// exported provenance file and its attestation on the machine of the client. A test file is in
// scope: a TUI test drives the client, not the server state.
const clientBoundaryBans = [
    {
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- an esquery attribute selector takes a regex, and `RegExp.toString()` gives its escaped text; a string method cannot test the source of an import in a selector
        selector: sourceSelector(/(^|\/)db\//),
        message: "A client must not import `src/db/`. Read and write the state through a route of the local server (`src/client/`).",
    },
    {
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- an esquery attribute selector takes a regex, and `RegExp.toString()` gives its escaped text; a string method cannot test the source of an import in a selector
        selector: sourceSelector(/(^|\/)server\//),
        message: "A client must not import `src/server/`. Call the server over HTTP through `src/client/`, and share a wire type through `src/api/`.",
    },
    {
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- an esquery attribute selector takes a regex, and `RegExp.toString()` gives its escaped text; a string method cannot test the source of an import in a selector
        selector: sourceSelector(/(^|\/)lib\/bus(\.ts)?$/),
        message: "A client must not import the bus: it is in-process to the server. Read the state again through a route on the next read edge.",
    },
    {
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- an esquery attribute selector takes a regex, and `RegExp.toString()` gives its escaped text; the lookahead allowlist has no string-method form in a selector
        selector: sourceSelector(/^@inflexa-ai\/harness(?!\/contracts\/|\/app\/data-profile-view(\.js)?$)/),
        message:
            "A client must not import the harness runtime. Only `@inflexa-ai/harness/contracts/*` and `@inflexa-ai/harness/app/data-profile-view` are pure. Get each other type from `src/api/`.",
    },
    {
        // `update/` acts only on the `inflexa` binary and its own notice state, which the client and the
        // server share. It holds no state of an analysis or of the server.
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- an esquery attribute selector takes a regex, and `RegExp.toString()` gives its escaped text; the lookahead allowlist has no string-method form in a selector
        selector: sourceSelector(/(^|\/)modules\/(?!harness\/plan_dag\.ts$|harness\/chat_printer\.ts$|prov\/verify_file\.ts$|update\/)/),
        message:
            "A client must not import a module of `src/modules/` that holds state or does I/O. Call a route of the local server through `src/client/`, or lift a pure helper out of the module.",
    },
];

// The opentui renderer bans for the non-test TUI source. A color is a `theme()` role, a shape glyph
// is a `GLYPHS` key: `src/lib/design_system.ts` owns both, outside this scope. The hex ban matches a
// whole value, so prose such as "step #12 of 40" passes. The glyph ban exempts only the
// typographic punctuation the prose already carries (em dash, ellipsis, middle dot, right arrow).
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the pattern is the argument of an esquery attribute selector, which takes a regex and gets its escaped text from `RegExp.toString()`; it matches a whole hex color value, with the Unicode white space of `\s` around it
const hexColor = /^\s*#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\s*$/;
// Written as a string because the control range `\x00` trips `no-control-regex` as a literal.
const nonGlyphPunctuation = String.raw`/[^\x00-\x7F—…·→]/`;

function literalSelector(pattern: RegExp | string): string {
    const regex = pattern.toString();
    return [`Literal[value=${regex}]`, `TemplateElement[value.cooked=${regex}]`, `JSXText[value=${regex}]`].join(", ");
}

const rendererBans = [
    {
        selector: literalSelector(hexColor),
        message: "Don't inline a hex color in `src/tui/` — resolve a role through `theme()` (or `<Fg role={…}>`), whose palette lives in src/lib/design_system.ts.",
    },
    {
        selector: literalSelector(nonGlyphPunctuation),
        message: "Don't inline a glyph literal in `src/tui/` — use a `GLYPHS` key from src/lib/design_system.ts. Only the em dash, ellipsis, middle dot, and right arrow are allowed in prose.",
    },
];

export default solid({
    env: { browser: true },
    overrides: [
        {
            files: ["**/*.{ts,tsx,js,mjs}"],
            rules: {
                "eslint-js/no-restricted-syntax": ["error", ...sharedBans, nodeEnvBan],
                // The preset sets the rule bare, which drops the `^_` escape of the
                // four ignore patterns.
                "typescript/no-unused-vars": [
                    "error",
                    {
                        argsIgnorePattern: "^_",
                        destructuredArrayIgnorePattern: "^_",
                        caughtErrorsIgnorePattern: "^_",
                        varsIgnorePattern: "^_",
                    },
                ],
                // A switch over a union must handle every member OR carry a `default`. Lenient mode
                // (`considerDefaultExhaustiveForUnions: true`) treats a `default` as covering the rest, so
                // intentional default-driven switches (platform, error codes, subset handlers) pass while a
                // switch that forgets a case AND has no fallback — the shape that silently drops a new
                // variant — is caught. Complements, not replaces, the `satisfies never` idiom in exhaustive
                // switches (which the type checker enforces regardless of this rule).
                "typescript/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
            },
        },
        {
            // The registry directory. `agent_policy.ts` is the one exception: `registerAction` itself is
            // the sanctioned site that legitimately calls `command.action(handler)`.
            files: ["src/cli/**"],
            excludeFiles: ["src/cli/agent_policy.ts"],
            rules: { "eslint-js/no-restricted-syntax": ["error", ...sharedBans, nodeEnvBan, ...actionBans] },
        },
        {
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
            // value that is deliberately not frozen. credential.test.ts does the same to exercise the `env`-kind
            // credential source, which reads the live environment through env.ts's `readEnvCredentialVar` helper.
            files: ["src/**"],
            excludeFiles: [
                "src/lib/env.ts",
                "src/lib/test/env.test.ts",
                "src/lib/test/credential.test.ts",
                "src/test_support/preload.ts",
                "src/test_support/sandbox.ts",
                "src/test_support/test/harness.test.ts",
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
        {
            // The dev-channel command surfaces live under `src/modules/harness/dev/` (see the `dev-commands`
            // spec and CLAUDE.md's "The `dev/` subdirectory"). The dependency runs ONE way: a dev surface is a
            // consumer of the product, so it may import product code, but a product file that imports `dev/`
            // would drag a command a release build does not carry into the product's own module graph.
            //
            // The pattern is `**/dev/*`, matched against the import STRING and not a resolved path. That
            // distinction is the whole trick: a sibling reaches the directory as `./dev/chat.ts`, so the
            // narrower-looking `**/modules/harness/dev/*` silently matches nothing from inside
            // `modules/harness/` and the rule reads as armed while catching nothing.
            //
            // The rule visits a dynamic `import()` as well as a static import and a re-export. The one
            // exemption is `src/modules/harness/dev/**`, because the surfaces import each other
            // (`dev/run.ts` → `dev/status.ts`). The registration gate at `src/cli/index.ts` is exempt by
            // inline directive at its two lazy imports only, so the file keeps the guard against a
            // top-level static import: the one form a release build WOULD evaluate, and the form a reader
            // reaches for the moment they want a type or a constant out of a dev action.
            files: ["src/**"],
            excludeFiles: ["src/modules/harness/dev/**"],
            rules: {
                "no-restricted-imports": [
                    "error",
                    {
                        patterns: [
                            {
                                group: ["**/dev/*", "**/dev/**"],
                                message:
                                    "A product file must not import `modules/harness/dev/` — those are dev-channel command surfaces a release build does not carry. If a helper is wanted by both, home it in the module that owns its subject (see CLAUDE.md, 'The `dev/` subdirectory').",
                            },
                        ],
                    },
                ],
            },
        },
        {
            files: ["src/tui/**", "src/client/**"],
            rules: { "eslint-js/no-restricted-syntax": ["error", ...sharedBans, nodeEnvBan, ...clientBoundaryBans] },
        },
        {
            files: ["src/tui/**"],
            excludeFiles: ["**/*.test.{ts,tsx}"],
            rules: { "eslint-js/no-restricted-syntax": ["error", ...sharedBans, nodeEnvBan, ...clientBoundaryBans, ...rendererBans] },
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
            // Preset rules that report on the tree. Each one stays off until the child
            // issue of #608 named above its group fixes the sites and removes the entry.
            // This block comes after every other override, so no other block turns a rule
            // back on.
            files: ["**/*.{ts,tsx,js,mjs}"],
            rules: {
                // #809: give each async test double the shape of the real function.
                "typescript/require-await": "off",

                // #811: the remaining preset rules.
                "typescript/explicit-function-return-type": "off",
                "typescript/no-base-to-string": "off",
                "typescript/restrict-template-expressions": "off",
                "typescript/restrict-plus-operands": "off",
                "typescript/no-invalid-void-type": "off",
                "typescript/unbound-method": "off",
                "typescript/no-deprecated": "off",
                "typescript/no-dynamic-delete": "off",
                "typescript/no-unnecessary-type-conversion": "off",
                "typescript/no-unnecessary-type-arguments": "off",
                "typescript/no-unnecessary-type-parameters": "off",
                "typescript/no-unnecessary-template-expression": "off",
                "typescript/no-unnecessary-boolean-literal-compare": "off",
                "typescript/no-redundant-type-constituents": "off",
                "typescript/no-misused-spread": "off",
                "typescript/prefer-promise-reject-errors": "off",
                "typescript/only-throw-error": "off",
                "typescript/no-confusing-void-expression": "off",
                "@inflexa-ai/no-instanceof-error": "off",
                "@inflexa-ai/no-typeof-object": "off",
                "@inflexa-ai/no-unknown-type-guards": "off",
                "@inflexa-ai/export-at-declaration": "off",
                "@inflexa-ai/no-empty-schema": "off",
                "@inflexa-ai/no-interface": "off",
                "solid/prefer-show": "off",
            },
        },
    ],
});
