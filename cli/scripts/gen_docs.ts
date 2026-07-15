// CLI reference generator: walks the commander registry and emits the publishable
// docs package (SSG-neutral CommonMark + manifest.json) into dist-docs/.
// Run via `bun run docs:gen` (or `bun scripts/gen_docs.ts`) — NEVER under `bun test`:
// src/lib/env.ts (imported by the registry) hard-fails a test process without the
// sandbox marker, because resolving env paths there risks pointing at real user data.
//
// The output is the docs contract consumed by the website (see the cli-reference-docs
// spec): portable CommonMark only — no admonitions/MDX/Vue syntax, every flag/usage
// token code-spanned (raw `<...>` parses as HTML in VitePress and Python-Markdown),
// and byte-deterministic (no timestamps, no machine-specific paths) so regenerating
// at a tagged commit reproduces exactly what CI verified.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Argument, Command, Option } from "commander";
import pkg from "../package.json";

// eslint-disable-next-line no-restricted-syntax -- the sanctioned "is this a `bun test` process?" question (same as env.ts's guard): the build channel is unset in both a source run and a test run, so only NODE_ENV can answer it.
if (process.env.NODE_ENV === "test") {
    console.error("gen_docs.ts must not run inside `bun test` (env.ts refuses test processes without the sandbox). Run `bun scripts/gen_docs.ts` directly.");
    process.exit(1);
}

// `dataVar`/`configVar` in env.ts are platform-dependent (LOCALAPPDATA vs XDG_DATA_HOME)
// and path joins use the platform separator — a Windows run would emit different bytes.
// Determinism is a contract property (the release regenerates what CI verified), so
// refuse rather than silently produce a divergent package.
if (process.platform === "win32") {
    console.error("gen_docs.ts output is only deterministic on POSIX platforms (env.ts base-var names differ on Windows).");
    process.exit(1);
}

// Document the RELEASE surface: dev-channel commands (`profile`/`run`/`chat`) register
// only when devCommandsEnabled(), which is true for any non-production build channel —
// including the unset channel of a plain source run like this one. Baking the production
// channel (and dropping the INFLEXA_DEV escape hatch) makes the registry import shape
// itself through the exact gate a shipped binary uses, so there is no command list to
// maintain here. Safe in this process: the only channel-sensitive value the import path
// touches is that gate (bakedEnv.gitCommit would throw under a production channel, but
// it is a lazy getter nothing here reads).
delete process.env.INFLEXA_DEV;
process.env.INFLEXA_BUILD_CHANNEL = "production";

// env.ts resolves every path from these base vars verbatim when set. Seeding them with
// their own names as literal placeholders makes `env.dbPath` come out as
// "$XDG_DATA_HOME/inflexa/agent.db" — machine-independent AND self-documenting, exactly
// what the environment page should print instead of the generating user's home dir.
process.env.XDG_DATA_HOME = "$XDG_DATA_HOME";
process.env.XDG_CONFIG_HOME = "$XDG_CONFIG_HOME";

// Dynamic imports so the env mutations above precede env.ts's import-time reads
// (static imports would hoist past them).
const { cli } = await import("../src/cli/index.ts");
const { env, envDoc } = await import("../src/lib/env.ts");
type EnvDocEntry = import("../src/lib/env.ts").EnvDocEntry;

const OUT_DIR = join(import.meta.dir, "..", "dist-docs");

// --- markdown building blocks -------------------------------------------------------

/** Escape the two tokens that survive CommonMark as live syntax downstream: `<` opens an HTML tag (VitePress, Python-Markdown), `{{` opens Vue interpolation. HTML entities stay literal text through both. */
function escapeProse(text: string): string {
    return text.replaceAll("<", "&lt;").replaceAll("{{", "&#123;&#123;");
}

/** Inline code span; backtick-containing content gets the double-backtick form. */
function codeSpan(text: string): string {
    return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}

/** A GFM table from rows of pre-rendered cells. `|` must be escaped per cell — even inside code spans — or it splits the row. */
function table(header: string[], rows: string[][]): string {
    const esc = (cell: string): string => cell.replaceAll("|", "\\|");
    const line = (cells: string[]): string => `| ${cells.map(esc).join(" | ")} |`;
    return [line(header), `|${header.map(() => " --- ").join("|")}|`, ...rows.map(line)].join("\n");
}

/** Frontmatter limited to title + description — the subset every SSG reads. JSON.stringify is a valid YAML double-quoted scalar, so arbitrary prose is safe. */
function frontmatter(title: string, description: string): string {
    return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---`;
}

// --- registry introspection ---------------------------------------------------------

/** Reconstruct the argument's usage token (`<name>`, `[paths...]`) — commander's own formatter is private. */
function argToken(arg: Argument): string {
    const name = `${arg.name()}${arg.variadic ? "..." : ""}`;
    return arg.required ? `<${name}>` : `[${name}]`;
}

/** Space-joined command path from the root, e.g. "inflexa prov export". */
function commandPath(pathNames: readonly string[], cmd: Command): string {
    return [...pathNames, cmd.name()].join(" ");
}

const helper = cli.createHelp();

/** Visible subcommands in declaration order, without the implicit `help` command the Help class appends. */
function visibleSubcommands(cmd: Command): Command[] {
    return helper.visibleCommands(cmd).filter((c) => c.name() !== "help");
}

/** Visible options in declaration order, without the implicit `-h, --help` the Help class appends. */
function visibleOptions(cmd: Command): Option[] {
    return helper.visibleOptions(cmd).filter((o) => o.name() !== "help");
}

// Completeness is build-enforced: a visible command/argument/option with an empty
// description would emit a blank docs cell, so collect every offender and refuse.
const offenders: string[] = [];

function checkDescriptions(cmd: Command, pathNames: readonly string[]): void {
    const path = commandPath(pathNames, cmd);
    if (!cmd.description()) offenders.push(`${path}: command has no description`);
    for (const arg of cmd.registeredArguments) {
        if (!arg.description) offenders.push(`${path}: argument ${argToken(arg)} has no description`);
    }
    for (const opt of visibleOptions(cmd)) {
        if (!opt.description) offenders.push(`${path}: option ${opt.flags} has no description`);
    }
    for (const sub of visibleSubcommands(cmd)) checkDescriptions(sub, [...pathNames, cmd.name()]);
}

// --- page rendering -------------------------------------------------------------------

type NavEntry = { title: string; path: string; items?: NavEntry[] };

const files = new Map<string, string>();

function renderCommandPage(cmd: Command, pathNames: readonly string[], filePath: string): void {
    const path = commandPath(pathNames, cmd);
    const subs = visibleSubcommands(cmd);
    const opts = visibleOptions(cmd);
    const args = cmd.registeredArguments;

    const sections: string[] = [
        frontmatter(path, cmd.description()),
        `# ${codeSpan(path)}`,
        escapeProse(cmd.description()),
        `## Usage\n\n\`\`\`\n${path} ${cmd.usage()}\n\`\`\``,
    ];

    if (args.length > 0) {
        sections.push(
            `## Arguments\n\n` +
                table(
                    ["Argument", "Required", "Description"],
                    args.map((a) => [codeSpan(argToken(a)), a.required ? "required" : "optional", escapeProse(a.description)]),
                ),
        );
    }

    if (opts.length > 0) {
        sections.push(
            `## Options\n\n` +
                table(
                    ["Option", "Description", "Default"],
                    opts.map((o) => [codeSpan(o.flags), escapeProse(o.description), o.defaultValue === undefined ? "" : codeSpan(String(o.defaultValue))]),
                ),
        );
    }

    if (subs.length > 0) {
        // Links are relative to THIS page's directory: a group index links into its own
        // dir-less children ("export.md"); the root index links into group dirs ("prov/index.md").
        const linkTo = (sub: Command): string => (visibleSubcommands(sub).length > 0 ? `${sub.name()}/index.md` : `${sub.name()}.md`);
        sections.push(
            `## Commands\n\n` +
                table(
                    ["Command", "Description"],
                    subs.map((sub) => [`[${codeSpan(commandPath([...pathNames, cmd.name()], sub))}](${linkTo(sub)})`, escapeProse(sub.description())]),
                ),
        );
    }

    // The env/paths appendix the root --help renders inline lives on its own page here.
    if (pathNames.length === 0) sections.push(`## See also\n\n- [Environment](environment.md) — paths and environment variables the CLI reads`);

    files.set(filePath, sections.join("\n\n") + "\n");
}

/** Render `cmd`'s page and recurse into subcommands, returning the nav entry for this subtree. */
function renderTree(cmd: Command, pathNames: readonly string[], dir: string): NavEntry {
    const subs = visibleSubcommands(cmd);
    const isRoot = pathNames.length === 0;
    const isGroup = subs.length > 0;
    // Root and groups are the index of their directory; leaves are plain files beside it.
    const filePath = isRoot ? "index.md" : isGroup ? join(dir, cmd.name(), "index.md") : join(dir, `${cmd.name()}.md`);
    renderCommandPage(cmd, pathNames, filePath);

    const entry: NavEntry = { title: isRoot ? cmd.name() : commandPath(pathNames, cmd), path: filePath };
    if (isGroup) {
        const childDir = isRoot ? dir : join(dir, cmd.name());
        entry.items = subs.map((sub) => renderTree(sub, [...pathNames, cmd.name()], childDir));
    }
    return entry;
}

function renderEnvironmentPage(): string {
    const pathRows: string[][] = [];
    const varRows: string[][] = [];
    // Mirror of renderEnvHelp's base-var aggregation (src/cli/index.ts): each override
    // var is documented once, naming every path it moves.
    const baseVarLabels = new Map<string, string[]>();

    for (const [key, doc] of Object.entries(envDoc) as [keyof typeof envDoc, EnvDocEntry][]) {
        if (doc.kind === "path") {
            // env paths resolve from the placeholder base vars seeded above, so this is
            // "$XDG_DATA_HOME/inflexa/…" — deterministic, not the generating machine's home.
            pathRows.push([doc.label, codeSpan(env[key] ?? ""), escapeProse(doc.description)]);
            baseVarLabels.set(doc.baseVar, [...(baseVarLabels.get(doc.baseVar) ?? []), doc.label]);
        } else {
            varRows.push([codeSpan(doc.name), escapeProse(doc.description)]);
        }
    }
    for (const [name, labels] of baseVarLabels) {
        varRows.push([codeSpan(name), `overrides the base directory for: ${labels.join(", ")}`]);
    }

    const description = "Paths and environment variables the inflexa CLI reads";
    return [
        frontmatter("Environment", description),
        `# Environment`,
        escapeProse(description),
        `## Paths\n\nWhen ${codeSpan("$XDG_DATA_HOME")} / ${codeSpan("$XDG_CONFIG_HOME")} are unset, the bases default to ${codeSpan("~/.local/share")} and ${codeSpan("~/.config")}.\n\n` +
            table(["Path", "Location", "Purpose"], pathRows),
        `## Variables\n\n` + table(["Variable", "Description"], varRows),
    ].join("\n\n") + "\n";
}

// --- main -----------------------------------------------------------------------------

checkDescriptions(cli, []);
if (offenders.length > 0) {
    console.error("docs generation refused — every visible command, argument, and option needs a description:");
    for (const offender of offenders) console.error(`  ${offender}`);
    process.exit(1);
}

const rootNav = renderTree(cli, [], "");
files.set("environment.md", renderEnvironmentPage());

const manifest = {
    schemaVersion: 1,
    cliVersion: pkg.version,
    name: cli.name(),
    // Registration order IS the curated order — never resort. Root page first, the
    // command tree as declared, the environment appendix last (mirroring --help).
    nav: [{ title: rootNav.title, path: rootNav.path }, ...(rootNav.items ?? []), { title: "Environment", path: "environment.md" }],
};
files.set("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

// Clean rebuild: stale pages from renamed/removed commands must not survive in the package.
rmSync(OUT_DIR, { recursive: true, force: true });
for (const [relPath, content] of files) {
    const absPath = join(OUT_DIR, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content);
}
console.log(`Wrote ${files.size} files to dist-docs/ (cli ${pkg.version}, ${manifest.nav.length} top-level nav entries).`);
