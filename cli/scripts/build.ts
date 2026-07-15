// Release build: compiles inflexa into a single executable with internal
// configuration baked in as compile-time constants. Run via `bun run build`;
// Bun loads a local .env automatically, CI provides real env vars.
//
// This is a Bun.build script rather than a `bun build` CLI call because the
// Solid JSX transform (@opentui/solid) is a bundler plugin, and plugins are
// only available through the JS API.
import { $ } from "bun";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { createSolidTransformPlugin, resetSolidTransformPluginState } from "@opentui/solid/bun-plugin";

import { audienceInvalidReason } from "../src/modules/auth/auth.ts";
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

const plugin = createSolidTransformPlugin();
for (const target of targets) {
    const name = `inflexa-${target.os}-${target.arch}`;

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
        //   • node-llama-cpp (+ its per-platform packages) — the local-embeddings native addon, loaded
        //     lazily via `import("node-llama-cpp")` only when `inflexa setup --embeddings local` is
        //     chosen (modules/embedding). Its loader fans out to `import("@node-llama-cpp/<platform>")`
        //     for ~16 platforms; only the host's package is installed, so bundling can't resolve the
        //     rest. Absence is already handled gracefully (local-provider.ts → "run setup", not a crash).
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
        external: ["node-llama-cpp", "@node-llama-cpp/*", "winston", "winston-transport", "@opentelemetry/exporter-logs-otlp-proto", "cpu-features"],
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
