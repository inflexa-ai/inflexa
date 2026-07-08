// A bun:test preload registered ONLY by the monorepo-root bunfig.toml (see the WHY there). It runs
// before any test module, and its whole job is to abort `bun test` at the root before a single cli/ or
// harness/ test file can run — and therefore before any of them can touch the developer's real home
// dir. There is deliberately no root test suite; this preload refuses the root run that has now twice
// destroyed live data.
//
// process.exit(1), NOT throw: bun 1.3.8 does NOT abort on a throwing preload — it logs the throw as
// an "unhandled error between tests" and then runs the ENTIRE suite anyway (verified: a throwing
// version still ran 1234 tests against the real home dir). Only a hard exit reliably stops bun before
// it executes tests, which is the entire point of this file.
const message =
    "This monorepo has no root test suite — run bun test from cli/ or harness/ (their bunfig preloads establish the required sandboxes).";
console.error(message);
process.exit(1);
