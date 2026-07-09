// A bun:test preload registered ONLY by the monorepo-root bunfig.toml (see the WHY there). It runs
// before any test module, and its whole job is to abort `bun test` at the root before a single cli/ or
// harness/ test file can run — and therefore before any of them can touch the developer's real home
// dir. There is deliberately no root test suite; this preload refuses the root run that has now twice
// destroyed live data.
//
// process.exit(1), NOT throw: bun does not treat a throwing preload as fatal — it reports the throw as
// an unhandled error between tests and then runs the ENTIRE suite anyway (observed: a throwing version
// still ran the whole cli suite against the real home dir). Whether a future bun tightens that is
// irrelevant here — a hard exit stops the run under every version, and "reliably stops bun before it
// executes tests" is this file's entire purpose. Do not soften it into a throw to satisfy a lint rule.
const message =
    "This monorepo has no root test suite — run bun test from cli/ (whose bunfig preload establishes the XDG sandbox) or from harness/.";
console.error(message);
process.exit(1);
