// Release build: compiles inflexa into a single executable with internal
// configuration baked in as compile-time constants. Run via `bun run build`;
// Bun loads a local .env automatically, CI provides real env vars.
//
// This is a Bun.build script rather than a `bun build` CLI call because the
// Solid JSX transform (@opentui/solid) is a bundler plugin, and plugins are
// only available through the JS API.
import { $ } from "bun";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { createSolidTransformPlugin, resetSolidTransformPluginState } from "@opentui/solid/bun-plugin";

import { audienceInvalidReason } from "../src/modules/auth/auth.ts";
import { LLAMA_PINS, LLAMA_RUNTIME_TAG, llamaArtifactUrl, type LlamaPin, type LlamaTargetKey } from "../src/modules/embedding/llama_runtime.ts";
import { MODEL_ARTIFACT, MODEL_SHA256, MODEL_URL } from "../src/modules/embedding/model_pin.ts";
import { contentHashOf, packContent, type PackEntry } from "../src/modules/harness/content-pack.ts";

// This process autoloads the repo bunfig.toml, whose preload installs
// opentui's runtime plugin support and sets a global resolvePath that
// rewrites imports to virtual `opentui:runtime-module:` specifiers only the
// dev runtime can load. Clear that state so the bundler plugin emits plain
// static imports the bundler can resolve.
resetSolidTransformPluginState();

// The bakedEnv block in env.ts is the single source of truth for which vars
// get baked: every literal `process.env.<NAME>` dot access inside it is
// collected here, so adding a value there is all it takes. The names cannot
// be derived at runtime (the object holds values, not names), hence reading
// the source.
const ENV_TS = "src/lib/env.ts";

function bakedVarNames(source: string): string[] {
    const block = source.match(/export const bakedEnv = Object\.freeze\(\{([\s\S]*?)\}\);/);
    if (!block || block[1] === undefined) {
        console.error(`error: could not find the bakedEnv Object.freeze block in ${ENV_TS}`);
        process.exit(1);
    }
    const names = [...new Set([...block[1].matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1] as string))];
    if (names.length === 0) {
        console.error(`error: no process.env.<NAME> dot accesses found in the bakedEnv block of ${ENV_TS}`);
        process.exit(1);
    }
    return names;
}

// Walk the repo-root skills/ and templates/ trees (relative to the cli/ build cwd) into PackEntry[] with
// forward-slash paths like `skills/foo/SKILL.md`. Entries are sorted and hashed downstream, so walk order
// does not matter. Only plain files are packed; directories recurse, other node types are skipped.
function collectContentEntries(): PackEntry[] {
    const out: PackEntry[] = [];
    for (const treeName of ["skills", "templates"] as const) {
        const root = join("..", treeName);
        if (!existsSync(root)) {
            console.error(`error: expected content tree ${root} (relative to cli/) does not exist`);
            process.exit(1);
        }
        walkContentTree(root, root, treeName, out);
    }
    return out;
}

function walkContentTree(dir: string, root: string, treeName: string, out: PackEntry[]): void {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, dirent.name);
        if (dirent.isDirectory()) {
            walkContentTree(abs, root, treeName, out);
        } else if (dirent.isFile()) {
            const rel = relative(root, abs).split(sep).join("/");
            out.push({ path: `${treeName}/${rel}`, bytes: readFileSync(abs) });
        }
    }
}

// Bake the exact source commit so a release binary can report what it was built from (the provenance
// `system` actor stamps it). Empty when this is not a git checkout; the production gate below rejects
// that, and a development build tolerates it (env.ts's resolveGitCommit shells out to git at runtime).
const gitCommit = await $`git rev-parse HEAD`
    .text()
    .then((sha) => sha.trim())
    .catch(() => "");

const bakedVars = bakedVarNames(await Bun.file(ENV_TS).text());

const define: Record<string, string> = {};
const missing: string[] = [];
for (const name of bakedVars) {
    const value = process.env[name];
    if (value) {
        define[`process.env.${name}`] = JSON.stringify(value);
    } else {
        missing.push(name);
    }
}
if (missing.length > 0) {
    console.error(`error: refusing to build a binary without these baked in: ${missing.join(", ")}`);
    process.exit(1);
}

// The audience must be the product API's identifier (a URI), not a pasted credential or the Auth0
// Management API — either would compile fine but break every login at runtime. Catch it here, where the
// operator can see it, using the SAME predicate the runtime resolver applies (one truth table, two
// gates). Non-null: the missing-var loop above guarantees both vars are present and non-empty.
const audienceReason = audienceInvalidReason(process.env.INFLEXA_AUTH0_AUDIENCE!, process.env.INFLEXA_AUTH0_DOMAIN!);
if (audienceReason !== null) {
    console.error(
        `error: INFLEXA_AUTH0_AUDIENCE is not a usable API identifier (${audienceReason}) — it must be the dedicated resource-server URI, not a credential or the Auth0 Management API`,
    );
    process.exit(1);
}

// Couple the bundler's NODE_ENV to our build channel, from the SINGLE operator input
// (INFLEXA_BUILD_CHANNEL, already present per the missing-var guard above). NODE_ENV governs how
// BUNDLED DEPENDENCIES compile (dev assertions/warnings vs production paths) — a separate axis from our
// own gate, which reads the channel via env.ts. Deriving NODE_ENV here, rather than trusting the
// operator to also export it, makes the two impossible to diverge (no `production` app atop `development`
// deps). It MUST be an explicit --define: Bun.build (the JS API this script uses) defaults NODE_ENV to
// "development" and does NOT read the ambient process.env value, so setting `process.env.NODE_ENV` would
// be silently ignored — only the define reaches both our code and the dependency tree.
const channel = process.env.INFLEXA_BUILD_CHANNEL;
if (channel !== "production" && channel !== "development") {
    console.error(`error: INFLEXA_BUILD_CHANNEL must be "production" or "development", got: ${JSON.stringify(channel)}`);
    process.exit(1);
}
define["process.env.NODE_ENV"] = JSON.stringify(channel);

// A production binary must know its own commit: the provenance `system` actor stamps it into every
// signed record, and an unknown commit makes a chain unattributable to a source tree. env.ts throws
// when a production build reads it unbaked — but that fires on the user's machine, at the moment they
// try to record provenance, long after the bad artifact shipped. Refuse here instead, where the
// operator can see it. A development build is allowed to omit it and resolve HEAD at runtime.
if (channel === "production" && !gitCommit) {
    console.error("error: refusing to build a production binary with no INFLEXA_GIT_COMMIT — `git rev-parse HEAD` produced nothing (not a git checkout?)");
    process.exit(1);
}
// An explicit --define rather than a `process.env.INFLEXA_GIT_COMMIT` access inside env.ts's bakedEnv
// block: that block's scanner applies its missing-var guard to EVERY channel, which would reject a
// development build outside a checkout. The commit's requirement is channel-conditional, so its gate is
// the branch above and its bake is here. Skipped when empty — a --define of "" would shadow the runtime
// fallback with a falsy literal, and `if (process.env.INFLEXA_GIT_COMMIT)` would then take the git path
// anyway, just less legibly.
if (gitCommit) define["process.env.INFLEXA_GIT_COMMIT"] = JSON.stringify(gitCommit);

// Bundled content: the shared repo-root skills/ + templates/ trees ride embedded in the binary and are
// extracted on first run (src/modules/harness/content.ts). Pack them into cli/content.pack — the path
// content.ts imports with `{ type: "file" }` — BEFORE the Bun.build loop, so the bundler embeds the
// archive, and --define the content hash so env.contentHash names the extraction dir. The hash is over
// content, so a skills/templates edit re-extracts on the next install; identical content reuses the dir.
// Same explicit-define treatment as INFLEXA_GIT_COMMIT (not the bakedEnv scanner, whose missing-var guard
// spans every channel). See content-pack.ts for the archive format.
const contentEntries = collectContentEntries();
if (contentEntries.length === 0) {
    console.error("error: no skills/templates files found to bundle — expected ../skills and ../templates relative to cli/");
    process.exit(1);
}
const contentHash = contentHashOf(contentEntries);
await Bun.write("content.pack", packContent(contentEntries));
define["process.env.INFLEXA_CONTENT_HASH"] = JSON.stringify(contentHash);
console.log(`packed ${contentEntries.length} content files → content.pack (hash ${contentHash})`);

// Stamp the artifact as the compiled single-file binary so runtime code can pick the right byte
// source for materialized assets — chiefly the llama-server runtime archive, which a compiled build
// extracts from its embedded asset while a source run downloads it (see embedding/llama_runtime.ts).
// A bare global identifier define (parsed as the literal `true`), NOT a `process.env` access:
// lib/install_context.ts reads it through a `typeof` guard, so a from-source/dev/test run — where this
// define never runs — sees it as undeclared and resolves to not-compiled. Baked for every target.
define["__INFLEXA_COMPILED__"] = "true";

// Release target matrix, built by `bun run build:all` (passes --all). The
// default `bun run build` compiles only the host target for quick local
// iteration. To ship a new platform, add it here — Bun cross-compiles by
// downloading that target's runtime at build time.
const TARGETS = [
    { os: "darwin", arch: "arm64" },
    { os: "darwin", arch: "x64" },
    { os: "linux", arch: "x64" },
    { os: "linux", arch: "arm64" },
    { os: "windows", arch: "x64" },
] as const;

const hostOs = process.platform === "win32" ? "windows" : process.platform;
const all = process.argv.includes("--all");
const targets = all ? TARGETS : TARGETS.filter((target) => target.os === hostOs && target.arch === process.arch);
if (targets.length === 0) {
    console.error(`error: host platform ${hostOs}-${process.arch} is not in the target matrix`);
    process.exit(1);
}

// A plain install keeps only the host's @opentui/core-<os>-<arch> native
// package; cross-builds need every target's variant present in node_modules.
// Same trick as opencode's build script.
if (targets.some((target) => target.os !== hostOs || target.arch !== process.arch)) {
    // Read via the filesystem: the package's exports map does not expose its
    // package.json for import.
    const opentuiVersion = (JSON.parse(await Bun.file("node_modules/@opentui/core/package.json").text()) as { version: string }).version;
    await $`bun install --os="*" --cpu="*" @opentui/core@${opentuiVersion}`.quiet();
}

await $`rm -rf dist`;

// Highlighting runs in opentui's tree-sitter worker, which the renderer spawns via
// `new Worker(resolveWorkerPath())`. That path is dynamic, so Bun's compiler can't auto-detect and
// embed the worker (Bun only auto-embeds `new Worker(new URL("./literal", import.meta.url))`); left
// alone, the binary falls back to loading parser.worker.ts from cwd and fails with ModuleNotFound.
// Adding the worker as a second entrypoint makes Bun bundle it (with web-tree-sitter and its
// tree-sitter.wasm) into the executable. opentui exposes it as the `@opentui/core/parser.worker`
// export expressly for this. (The grammar wasm/scm load via `with { type: "file" }` embeds in
// src/tui/grammars/register.ts — a separate mechanism that needs no build wiring.)
//
// `buildRoot` pins Bun's project root: a standalone executable embeds each entrypoint at
// `<bunfs-root>/<path-RELATIVE-to-the-build-root>`, NOT at its absolute path. The default root is the
// common ancestor of the entrypoints — for us that is the repo (both src/index.ts and the worker live
// under it) — so the worker embeds at `/$bunfs/root/node_modules/@opentui/core/parser.worker.js`. We
// pin the root and derive the path the SAME way, instead of guessing, so the baked worker path matches
// where Bun actually puts it. (Computing from the absolute path silently broke highlighting: the path
// only happened to match when entrypoints lived in different filesystem trees.)
const buildRoot = process.cwd();
const workerEntry = Bun.resolveSync("@opentui/core/parser.worker", buildRoot);
const workerRelToRoot = relative(buildRoot, workerEntry);

// On-disk cache for the build-time embedded artifacts — the per-target llama-server release archives
// (local-embeddings sidecar runtime) AND the platform-independent embedding-model GGUF — kept OUTSIDE git
// (see .gitignore) so a rebuild need not re-download them. Each artifact MUST be present here before
// Bun.build so the define-gated `import(... with { type: "file" })` (in src/modules/embedding/llama_runtime.ts
// for the archives, src/modules/embedding/setup.ts for the model) can embed it. A host-only `bun run build`
// caches only the host target's archive plus the one model: the other three targets' archive imports are
// DCE'd away (their `__INFLEXA_LLAMA_TARGET__` comparisons fold to false) and never resolved, so those
// archives are neither needed nor fetched.
const LLAMA_CACHE_DIR = join(process.cwd(), ".llama-cache");

// Ensure `targetKey`'s pinned archive sits in the cache, hash-verified against the vendored SHA-256
// (the SOLE integrity authority — upstream publishes no checksums). A cache hit re-verifies rather than
// trusting the bytes on disk. Any fetch/hash failure fails the build LOUDLY (process.exit(1)) — a binary
// that silently embedded the wrong or a corrupt runtime is worse than no binary. Returns the validated
// LlamaTargetKey to bake into the per-target define. Shares ONE hash source with the runtime by importing
// LLAMA_PINS, so the build-time and first-run verifications can never disagree.
async function ensureLlamaArchiveCached(targetKey: string): Promise<LlamaTargetKey> {
    const pin: LlamaPin | undefined = (LLAMA_PINS as Record<string, LlamaPin>)[targetKey];
    if (!pin) {
        console.error(`error: no vendored llama-server pin for build target ${targetKey} (add it to LLAMA_PINS in src/modules/embedding/llama_runtime.ts)`);
        process.exit(1);
    }
    const cachedPath = join(LLAMA_CACHE_DIR, pin.artifact);
    if (existsSync(cachedPath)) {
        const cachedDigest = new Bun.CryptoHasher("sha256").update(await Bun.file(cachedPath).bytes()).digest("hex");
        if (cachedDigest === pin.sha256) return pin.target;
        console.error(`error: cached ${pin.artifact} sha256 ${cachedDigest} does not match the vendored pin ${pin.sha256} — delete ${LLAMA_CACHE_DIR} and rebuild`);
        process.exit(1);
    }
    const url = llamaArtifactUrl(LLAMA_RUNTIME_TAG, pin);
    console.log(`fetching llama-server runtime ${pin.artifact} (${pin.target}) …`);
    const response = await fetch(url);
    if (!response.ok) {
        console.error(`error: could not download ${url} — HTTP ${response.status} ${response.statusText}`);
        process.exit(1);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (digest !== pin.sha256) {
        console.error(`error: downloaded ${pin.artifact} sha256 ${digest} does not match the vendored pin ${pin.sha256} — upstream may have re-cut the release; refusing to embed it`);
        process.exit(1);
    }
    await Bun.write(cachedPath, bytes); // Bun.write creates LLAMA_CACHE_DIR if absent
    console.log(`cached ${pin.artifact} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
    return pin.target;
}

// Ensure the pinned embedding-model GGUF sits in the cache, hash-verified against MODEL_SHA256. The model
// is platform-independent, so unlike the per-target llama-server archives it is cached ONCE per build and
// embedded into EVERY target binary via the `__INFLEXA_COMPILED__`-gated import in
// src/modules/embedding/setup.ts (one asset, no per-target DCE selection). MODEL_SHA256 is the SAME
// integrity authority runtime acquisition re-applies (one hash source, two gates), so the build-time and
// first-run verifications can never disagree. A cache hit re-verifies rather than trusting the bytes on
// disk. Any fetch/hash failure fails the build LOUDLY (process.exit(1)) — a binary that silently embedded
// a wrong or corrupt model is worse than no binary.
async function ensureModelCached(): Promise<void> {
    const cachedPath = join(LLAMA_CACHE_DIR, MODEL_ARTIFACT);
    if (existsSync(cachedPath)) {
        const cachedDigest = new Bun.CryptoHasher("sha256").update(await Bun.file(cachedPath).bytes()).digest("hex");
        if (cachedDigest === MODEL_SHA256) return;
        console.error(`error: cached ${MODEL_ARTIFACT} sha256 ${cachedDigest} does not match the vendored pin ${MODEL_SHA256} — delete ${LLAMA_CACHE_DIR} and rebuild`);
        process.exit(1);
    }
    console.log(`fetching embedding model ${MODEL_ARTIFACT} …`);
    const response = await fetch(MODEL_URL);
    if (!response.ok) {
        console.error(`error: could not download ${MODEL_URL} — HTTP ${response.status} ${response.statusText}`);
        process.exit(1);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (digest !== MODEL_SHA256) {
        console.error(`error: downloaded ${MODEL_ARTIFACT} sha256 ${digest} does not match the vendored pin ${MODEL_SHA256} — upstream may have re-cut the file; refusing to embed it`);
        process.exit(1);
    }
    await Bun.write(cachedPath, bytes); // Bun.write creates LLAMA_CACHE_DIR if absent
    console.log(`cached ${MODEL_ARTIFACT} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
}

// Remove every cache file that matches no current pin BEFORE compiling — covering both artifact kinds: the
// per-target llama-server archives (LLAMA_PINS) and the platform-independent embedding-model GGUF
// (MODEL_ARTIFACT). A pin bump renames the artifacts (new tag/revision → new filenames) but leaves the
// superseded files on disk; if the embed-import literals in llama_runtime.ts / setup.ts were not all
// updated in lockstep, a stale literal could still resolve against one of those leftover files and embed
// the WRONG artifact silently. Deleting them turns that mistake into a loud import-resolution build failure
// instead — the same failure a clean CI checkout would produce. Only flat files live here, so directories
// (none expected) are left untouched.
function sweepLlamaCache(): void {
    if (!existsSync(LLAMA_CACHE_DIR)) return;
    // Widen to Set<string>: LLAMA_PINS is `as const` (and MODEL_ARTIFACT is a literal too), so the artifact
    // names infer a literal union that would reject a plain-string `.has(entry.name)` membership test.
    const currentArtifacts = new Set<string>([...Object.values(LLAMA_PINS).map((pin) => pin.artifact), MODEL_ARTIFACT]);
    for (const entry of readdirSync(LLAMA_CACHE_DIR, { withFileTypes: true })) {
        if (!entry.isFile() || currentArtifacts.has(entry.name)) continue;
        rmSync(join(LLAMA_CACHE_DIR, entry.name), { force: true });
        console.log(`swept stale llama-cache file ${entry.name} (matches no current pin)`);
    }
}

sweepLlamaCache();

// Fetch + verify the platform-independent embedding model ONCE, outside the target loop: every target
// embeds the same asset (D7), so a per-target fetch would be wasted work.
await ensureModelCached();

const plugin = createSolidTransformPlugin();
for (const target of targets) {
    const name = `inflexa-${target.os}-${target.arch}`;

    // Fetch + verify this target's llama-server archive before compiling, so the embedded-asset import
    // resolves and each binary carries exactly its own runtime.
    const llamaTarget = await ensureLlamaArchiveCached(`${target.os}-${target.arch}`);

    // resolveWorkerPath prefers the global OTUI_TREE_SITTER_WORKER_PATH over its default, so bake the
    // worker's embedded bunfs path in (the default `new URL("./parser.worker.js", …)` can't find it —
    // the worker is a separate entrypoint, not beside the main bundle). Verified on darwin/linux.
    // Windows uses the B:\~BUN\root root with backslashes; that mapping is unverified (cross targets
    // aren't smoke-tested), so highlighting may degrade gracefully there (warmGrammars swallows a
    // worker failure) — text still renders, just unstyled.
    const workerBunfsPath = target.os === "windows" ? `B:\\~BUN\\root\\${workerRelToRoot.split("/").join("\\")}` : `/$bunfs/root/${workerRelToRoot}`;
    const targetDefine: Record<string, string> = {
        ...define,
        OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(workerBunfsPath),
        // Selects which embedded llama-server archive materializes at first use (llama_runtime.ts), and
        // is the DCE key that drops the other three targets' `import(... with { type: "file" })` so this
        // binary embeds EXACTLY its own ~10 MB runtime. A bare global identifier define (parsed as the
        // string literal), matching the __INFLEXA_COMPILED__ precedent — llama_runtime.ts reads it under
        // a `typeof` guard, so a from-source run (no define) sees it undeclared and falls to the download path.
        __INFLEXA_LLAMA_TARGET__: JSON.stringify(llamaTarget),
        // opentui's native loader consults OPENTUI_LIBC on linux to pick the glibc vs musl lib; bake it
        // so the choice cannot be swayed at runtime (per opencode's build; we only ship glibc).
        ...(target.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify("glibc") } : {}),
    };

    const result = await Bun.build({
        entrypoints: ["src/index.ts", workerEntry],
        root: buildRoot,
        define: targetDefine,
        plugins: [plugin],
        // Optional deps that must NOT be bundled — each is a runtime import/require never reached in a
        // normal inflexa run, but the bundler would otherwise try (and fail) to resolve it statically:
        //   • winston, winston-transport, @opentelemetry/exporter-logs-otlp-proto — @dbos-inc/dbos-sdk
        //     `require()`s these ONLY on its OTLP-telemetry path, behind `if (!enableOTLP) return`.
        //     enableOTLP defaults to `process.env.DBOS__CLOUD === 'true'` (dbos utils.js) and the harness
        //     never enables it (runtime/dbos.ts sets no telemetry config), so those lines never execute in
        //     a local binary. The packages aren't installed (dbos-sdk fails to declare them as
        //     optionalDependencies), so external keeps the never-hit requires out of the bundle. Matches
        //     the harness's documented posture (runtime/otel-smoke.test.ts: OTLP exporter absent, DBOS degrades).
        //   • cpu-features — a native addon (`require('../build/Release/cpufeatures.node')`, unbuilt here)
        //     that ssh2 loads inside a try/catch purely to detect CPU crypto acceleration; ssh2 arrives via
        //     dockerode → docker-modem and is only exercised over an SSH docker transport, which the local
        //     backend never uses (unix socket / TCP). external stops the bundler descending into the package
        //     and resolving its .node file; the runtime require then throws and ssh2's catch swallows it.
        external: ["winston", "winston-transport", "@opentelemetry/exporter-logs-otlp-proto", "cpu-features"],
        compile: {
            target: `bun-${target.os}-${target.arch}`,
            // Bun appends .exe automatically for windows targets.
            outfile: `dist/${name}`,
            // A release binary must not change behavior based on files in the
            // user's cwd — the repo's own bunfig.toml preload (dev-only Solid
            // transform) would even crash it at startup.
            autoloadBunfig: false,
            autoloadDotenv: false,
        },
    });

    if (!result.success) {
        console.error(`error: build failed for ${name}`);
        for (const log of result.logs) console.error(String(log));
        process.exit(1);
    }

    // Smoke test: catches binaries that compile but cannot even start
    // (missing embedded assets, autoload regressions, plugin
    // misconfiguration). Only the host's binary can run here.
    if (target.os === hostOs && target.arch === process.arch) {
        try {
            const version = (await $`./dist/${name} --version`.text()).trim();
            console.log(`built dist/${name} (smoke test: --version → ${version})`);
        } catch (cause) {
            console.error(`error: smoke test failed — dist/${name} --version did not run: ${String(cause)}`);
            process.exit(1);
        }
    } else {
        console.log(`built dist/${name} (cross-compiled, not smoke-tested)`);
    }
}

// Compiling the deps into the binary makes us their redistributor, so the
// license/NOTICE text of every bundled package must ship alongside the
// executables. Generated fresh each build because the resolved tree drifts;
// it is never hand-maintained.
const thirdParty = collectThirdPartyLicenses(process.cwd());
await Bun.write("dist/THIRD-PARTY-NOTICES.txt", renderThirdPartyNotices(thirdParty));
console.log(`wrote dist/THIRD-PARTY-NOTICES.txt (${thirdParty.length} packages)`);

type ThirdPartyPackage = {
    name: string;
    version: string;
    license: string;
    homepage: string | null;
    licenseText: string | null;
    noticeText: string | null;
};

// Walk the *production* dependency graph (dependencies + optionalDependencies,
// never devDependencies — those are not in the binary) and collect each
// package's bundled license and NOTICE text. The set is a conservative
// superset of what the bundler actually embeds: over-attribution is harmless,
// under-attribution is the legal risk.
function collectThirdPartyLicenses(rootDir: string): ThirdPartyPackage[] {
    const seenDirs = new Set<string>();
    const collected = new Map<string, ThirdPartyPackage>();
    const queue: Array<{ name: string; fromDir: string }> = [];

    function enqueue(deps: Record<string, string> | undefined, fromDir: string): void {
        if (!deps) return;
        for (const name of Object.keys(deps)) queue.push({ name, fromDir });
    }

    // Mirror Node's package resolution by hand: a package's exports map can
    // block importing its package.json, so we read off disk and walk up the
    // node_modules chain to honor both nesting and hoisting.
    function findPackageDir(name: string, fromDir: string): string | null {
        let dir = fromDir;
        for (;;) {
            const candidate = join(dir, "node_modules", name);
            if (existsSync(join(candidate, "package.json"))) return candidate;
            const parent = dirname(dir);
            if (parent === dir) return null;
            dir = parent;
        }
    }

    function readMatchingText(pkgDir: string, matcher: RegExp): string | null {
        let entries: string[];
        try {
            entries = readdirSync(pkgDir);
        } catch {
            return null;
        }
        // Concatenate all matches so dual-licensed packages (LICENSE-MIT +
        // LICENSE-APACHE) keep both texts.
        const texts = entries
            .filter((entry) => matcher.test(entry))
            .sort()
            .map((entry) => {
                try {
                    return readFileSync(join(pkgDir, entry), "utf8").trim();
                } catch {
                    return "";
                }
            })
            .filter((text) => text.length > 0);
        return texts.length > 0 ? texts.join("\n\n") : null;
    }

    const rootPkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
    };
    enqueue(rootPkg.dependencies, rootDir);
    enqueue(rootPkg.optionalDependencies, rootDir);

    while (queue.length > 0) {
        const item = queue.shift();
        if (!item) continue;
        const pkgDir = findPackageDir(item.name, item.fromDir);
        if (!pkgDir || seenDirs.has(pkgDir)) continue;
        seenDirs.add(pkgDir);

        const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
            name?: string;
            version?: string;
            // legacy packages express license as a {type} object or an array;
            // we only surface a string id and otherwise rely on the file text.
            license?: unknown;
            homepage?: string;
            dependencies?: Record<string, string>;
            optionalDependencies?: Record<string, string>;
        };
        const pkgName = pkg.name ?? item.name;
        const version = pkg.version ?? "0.0.0";
        const key = `${pkgName}@${version}`;
        if (!collected.has(key)) {
            collected.set(key, {
                name: pkgName,
                version,
                license: typeof pkg.license === "string" ? pkg.license : "SEE LICENSE FILE",
                homepage: typeof pkg.homepage === "string" ? pkg.homepage : null,
                licenseText: readMatchingText(pkgDir, /^(licen[cs]e|copying)/i),
                noticeText: readMatchingText(pkgDir, /^notice/i),
            });
        }

        // Resolve transitive deps from this package's own dir so a nested
        // copy wins over a hoisted one.
        enqueue(pkg.dependencies, pkgDir);
        enqueue(pkg.optionalDependencies, pkgDir);
    }

    return [...collected.values()].sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
}

function renderThirdPartyNotices(packages: ThirdPartyPackage[]): string {
    const divider = "=".repeat(78);
    const header = [
        "Inflexa — Third-Party Software Notices",
        "",
        "The Inflexa binary is compiled together with the open-source packages listed",
        "below. Each is distributed under its own license, reproduced here as those",
        "licenses require. This file is generated at build time from the resolved",
        "dependency tree — do not edit it by hand.",
        "",
        `Packages: ${packages.length}`,
    ].join("\n");

    const sections = packages.map(function (pkg): string {
        const lines = [divider, `${pkg.name}@${pkg.version}`, `License: ${pkg.license}`];
        if (pkg.homepage) lines.push(`Homepage: ${pkg.homepage}`);
        lines.push("");
        lines.push(pkg.licenseText ?? `(No license file bundled; declared license: ${pkg.license}.)`);
        if (pkg.noticeText) lines.push("", "--- NOTICE ---", "", pkg.noticeText);
        return lines.join("\n");
    });

    return [header, ...sections, divider, ""].join("\n\n");
}
