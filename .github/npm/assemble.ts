// Assembles the npm distribution for one released version from its release
// assets: four platform packages (each carrying one binary, install-gated by
// os/cpu) and the @inflexa-ai/inflexa wrapper whose launcher resolves
// whichever platform package npm delivered. Run with bun:
//
//   bun .github/npm/assemble.ts --version 0.1.0 --assets <dir> --out <dir>
//
// <dir> must hold the release's binaries, SHA256SUMS, and
// THIRD-PARTY-NOTICES.txt (gh release download provides all of them).
// Every binary is verified against SHA256SUMS before it is packaged — the
// npm packages must carry exactly what the release workflow built and
// attested, never a locally rebuilt or tampered file.
//
// The wrapper pins each platform package to the exact version (not a range)
// so a launcher can never resolve a binary from a different release, and the
// notices file ships in every platform package because the binary compiles
// its dependencies in — installing it is redistribution.
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DESCRIPTION = "Local-first AI agent for reproducible biological data analysis";
const REPO_URL = "https://github.com/inflexa-ai/inflexa";

type Platform = {
    /** npm naming: process.platform-process.arch, the launcher's lookup key. */
    npmSuffix: string;
    /** Release asset name (the release says "windows" where npm says "win32"). */
    asset: string;
    /** Installed binary filename inside the platform package's bin/. */
    bin: string;
    os: string;
    cpu: string;
    /** Only set for Linux: the libc the binary links against. */
    libc?: string;
};

const PLATFORMS: Platform[] = [
    { npmSuffix: "darwin-arm64", asset: "inflexa-darwin-arm64", bin: "inflexa", os: "darwin", cpu: "arm64" },
    { npmSuffix: "darwin-x64", asset: "inflexa-darwin-x64", bin: "inflexa", os: "darwin", cpu: "x64" },
    { npmSuffix: "linux-x64", asset: "inflexa-linux-x64", bin: "inflexa", os: "linux", cpu: "x64", libc: "glibc" },
    { npmSuffix: "linux-arm64", asset: "inflexa-linux-arm64", bin: "inflexa", os: "linux", cpu: "arm64", libc: "glibc" },
    { npmSuffix: "win32-x64", asset: "inflexa-windows-x64.exe", bin: "inflexa.exe", os: "win32", cpu: "x64" },
];

function arg(name: string): string {
    const index = process.argv.indexOf(`--${name}`);
    const value = index >= 0 ? process.argv[index + 1] : undefined;
    if (!value) {
        console.error(`error: missing --${name}`);
        process.exit(1);
    }
    return value;
}

const version = arg("version");
const assetsDir = arg("assets");
const outDir = arg("out");

if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) {
    console.error(`error: version must be bare semver (got: ${version})`);
    process.exit(1);
}

const sums = new Map<string, string>();
for (const line of readFileSync(join(assetsDir, "SHA256SUMS"), "utf8").split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (hash && name) sums.set(name, hash);
}

const shared = {
    license: "Apache-2.0",
    homepage: REPO_URL,
    repository: { type: "git", url: `git+${REPO_URL}.git` },
    publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
};

rmSync(outDir, { recursive: true, force: true });

for (const platform of PLATFORMS) {
    const expected = sums.get(platform.asset);
    if (!expected) {
        console.error(`error: ${platform.asset} is not listed in SHA256SUMS`);
        process.exit(1);
    }
    const binary = readFileSync(join(assetsDir, platform.asset));
    const actual = createHash("sha256").update(binary).digest("hex");
    if (actual !== expected) {
        console.error(`error: checksum mismatch for ${platform.asset} — expected ${expected}, got ${actual}`);
        process.exit(1);
    }

    const pkgDir = join(outDir, `inflexa-${platform.npmSuffix}`);
    mkdirSync(join(pkgDir, "bin"), { recursive: true });
    writeFileSync(join(pkgDir, "bin", platform.bin), binary);
    chmodSync(join(pkgDir, "bin", platform.bin), 0o755);
    cpSync(join(assetsDir, "THIRD-PARTY-NOTICES.txt"), join(pkgDir, "THIRD-PARTY-NOTICES.txt"));
    writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify(
            {
                name: `@inflexa-ai/inflexa-${platform.npmSuffix}`,
                version,
                description: `${platform.npmSuffix} binary for @inflexa-ai/inflexa`,
                ...shared,
                os: [platform.os],
                cpu: [platform.cpu],
                ...(platform.libc ? { libc: [platform.libc] } : {}),
                files: ["bin", "THIRD-PARTY-NOTICES.txt"],
            },
            null,
            2,
        ) + "\n",
    );
    console.log(`assembled @inflexa-ai/inflexa-${platform.npmSuffix}@${version} (${platform.asset} verified)`);
}

const wrapperDir = join(outDir, "inflexa");
mkdirSync(join(wrapperDir, "bin"), { recursive: true });
cpSync(join(import.meta.dir, "launcher.js"), join(wrapperDir, "bin", "inflexa.js"));
cpSync(join(import.meta.dir, "postinstall.js"), join(wrapperDir, "postinstall.js"));

const optionalDependencies: Record<string, string> = {};
for (const platform of PLATFORMS) {
    optionalDependencies[`@inflexa-ai/inflexa-${platform.npmSuffix}`] = version;
}

writeFileSync(
    join(wrapperDir, "package.json"),
    JSON.stringify(
        {
            name: "@inflexa-ai/inflexa",
            version,
            description: DESCRIPTION,
            ...shared,
            bin: { inflexa: "bin/inflexa.js" },
            files: ["bin", "postinstall.js"],
            scripts: { postinstall: "node postinstall.js" },
            engines: { node: ">=18" },
            optionalDependencies,
        },
        null,
        2,
    ) + "\n",
);

writeFileSync(
    join(wrapperDir, "README.md"),
    [
        "# Inflexa",
        "",
        DESCRIPTION + ".",
        "",
        "```bash",
        "npm install -g @inflexa-ai/inflexa",
        "inflexa",
        "```",
        "",
        "This package delivers a self-contained native binary through a",
        "platform-specific optional dependency; Node.js only hosts the thin",
        "launcher. Docs, source, and other install channels (Homebrew, install",
        `scripts): ${REPO_URL}`,
        "",
    ].join("\n"),
);

console.log(`assembled @inflexa-ai/inflexa@${version} (wrapper)`);
