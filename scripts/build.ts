// Release build: compiles inf into a single executable with internal
// configuration baked in as compile-time constants. Run via `bun run build`;
// Bun loads a local .env automatically, CI provides real env vars.
//
// This is a Bun.build script rather than a `bun build` CLI call because the
// Solid JSX transform (@opentui/solid) is a bundler plugin, and plugins are
// only available through the JS API.
import { $ } from "bun";

import { createSolidTransformPlugin, resetSolidTransformPluginState } from "@opentui/solid/bun-plugin";

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

// Release target matrix, built by `bun run build:all` (passes --all). The
// default `bun run build` compiles only the host target for quick local
// iteration. To ship a new platform, add it here — Bun cross-compiles by
// downloading that target's runtime at build time.
const TARGETS = [
    { os: "darwin", arch: "arm64" },
    { os: "darwin", arch: "x64" },
    { os: "linux", arch: "x64" },
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

const plugin = createSolidTransformPlugin();
for (const target of targets) {
    const name = `inf-${target.os}-${target.arch}`;
    const result = await Bun.build({
        entrypoints: ["src/index.ts"],
        // opentui's native loader consults OPENTUI_LIBC on linux to pick the
        // glibc vs musl lib; bake it so the choice cannot be swayed at
        // runtime (per opencode's build; we only ship glibc).
        define: target.os === "linux" ? { ...define, "process.env.OPENTUI_LIBC": JSON.stringify("glibc") } : define,
        plugins: [plugin],
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
