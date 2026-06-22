import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";

import { activeRuntime } from "../../lib/config.ts";
import { capture, ensureReady, inherit, ContainerRuntimeError, type ContainerRuntime } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";

// `inf setup` provisions CLIProxyAPI (https://help.router-for.me) as a container,
// authenticates a provider, and starts it. We run it in a container — the project
// ships an official image, so this drops the per-OS binary download entirely and
// keeps one runtime across macOS, Linux, and Windows. The backing system (Docker
// or Podman) is a config key; every container call goes through the
// lib/container.ts wrapper rather than a hard-coded binary.
//
// State we own — the config and the provider-credential directory — lives under
// our data dir (env.cliproxyConfigPath / env.cliproxyAuthDir) and is bind-
// mounted into the container. Paths *inside* the config are container paths, so
// they are always Linux regardless of the host OS.
//
// The proxy lifecycle lives here, with its owning command, rather than in lib/
// (which is reserved for cross-cutting infrastructure). The pieces the TUI reuse
// are ensureProxyReady() and its exit-on-error variant ensureProxyReadyOrExit().

// --- command ---------------------------------------------------------------

type SetupOptions = {
    /** Commander fills these in from the flags registered in src/cli/index.ts. */
    provider?: string;
    auth: boolean;
    start: boolean;
    force: boolean;
};

export async function setup(options: SetupOptions): Promise<void> {
    try {
        const provider = resolveProvider(options);
        const rt = activeRuntime();

        await ensureReady(rt);

        const { created, apiKey } = await writeProxyConfig();
        if (created) {
            console.log(`\n  Wrote ${env.cliproxyConfigPath}`);
            if (apiKey) console.log(`  Client API key (use this to call the proxy): ${apiKey}`);
        } else {
            console.log(`\n  Keeping existing config at ${env.cliproxyConfigPath}`);
        }

        await pullImage(rt, options.force);

        if (options.auth) {
            // Credentials persist in the mounted auth dir, so re-running setup
            // shouldn't force a re-login. Skip the prompt when already signed in;
            // an explicit --provider still triggers a fresh login to add/switch.
            if (provider === undefined && (await isAuthenticated())) {
                console.log("  Already authenticated — skipping login (use `--provider <name>` to add or switch).");
            } else {
                const authed = await authenticate(rt, provider);
                if (!authed) console.log("  No provider authenticated yet — re-run `inf setup` to sign in.");
            }
        }

        if (options.start) await startProxy(rt);

        printNextSteps(options);
    } catch (error) {
        if (error instanceof ProxyError || error instanceof ContainerRuntimeError) {
            console.error(`\n  ${error.message}\n`);
        } else {
            console.error("\n  Setup failed unexpectedly:", error, "\n");
        }
        process.exitCode = 1;
    }
}

function resolveProvider(options: SetupOptions): Provider | undefined {
    if (options.provider === undefined) return undefined;
    if (!isProvider(options.provider)) {
        throw new ProxyError(`Unknown provider '${options.provider}'. Choose one of: ${PROVIDERS.join(", ")}.`);
    }
    return options.provider;
}

function printNextSteps(options: SetupOptions): void {
    console.log("\n  Done.");
    if (!options.start) console.log("  The proxy starts automatically the next time you run `inf`.");
    console.log(`  The TUI talks to the proxy at ${env.cliproxyBaseUrl}.`);
    console.log();
}

// --- proxy runtime ---------------------------------------------------------

const IMAGE = "eceasy/cli-proxy-api:latest";
const CONTAINER_NAME = "inf-cliproxy";

/**
 * The image runs `./CLIProxyAPI` from WORKDIR /CLIProxyAPI (see upstream
 * Dockerfile); these are the in-container paths the binary reads.
 */
const CONTAINER_BINARY = "./CLIProxyAPI";
const CONTAINER_CONFIG_PATH = "/CLIProxyAPI/config.yaml";
const CONTAINER_AUTH_DIR = "/root/.cli-proxy-api";

type Provider = "gemini" | "openai" | "claude" | "qwen" | "iflow";

const PROVIDER_LOGIN_FLAG: Record<Provider, string> = {
    gemini: "--login",
    openai: "--codex-login",
    claude: "--claude-login",
    qwen: "--qwen-login",
    iflow: "--iflow-login",
};
const PROVIDER_LABEL: Record<Provider, string> = {
    gemini: "Gemini (Google)",
    openai: "OpenAI (Codex/GPT)",
    claude: "Claude (Anthropic)",
    qwen: "Qwen",
    iflow: "iFlow",
};
/**
 * OAuth-callback flows need their port published so the browser redirect to
 * localhost reaches the one-shot login container. Qwen uses a device flow and
 * needs no inbound port.
 */
const PROVIDER_CALLBACK_PORT: Record<Provider, number | null> = {
    gemini: 8085,
    openai: 1455,
    claude: 54545,
    qwen: null,
    iflow: 11451,
};
const PROVIDERS = Object.keys(PROVIDER_LOGIN_FLAG) as Provider[];

/**
 * Expected, user-actionable failures. Callers print `.message` and exit rather
 * than dumping a stack.
 */
export class ProxyError extends Error {}

function isProvider(value: string): value is Provider {
    return (PROVIDERS as string[]).includes(value);
}

// --- container plumbing ----------------------------------------------------
//
// All commands go through the lib/container.ts wrapper (capture/inherit), which
// spawns the runtime resolved from config. Only the binary and the bind-mount
// flags differ between Docker and Podman; the subcommands below are identical.

async function imageExists(rt: ContainerRuntime): Promise<boolean> {
    return (await capture(rt, ["image", "inspect", IMAGE])).code === 0;
}

async function pullImage(rt: ContainerRuntime, force: boolean): Promise<void> {
    if (!force && (await imageExists(rt))) return;
    console.log(`  Pulling ${IMAGE}…`);
    if ((await inherit(rt, ["pull", IMAGE])) !== 0) throw new ProxyError(`Failed to pull ${IMAGE}.`);
}

/**
 * Resolve our container's id, or null if it doesn't exist. `^name$` makes the
 * name filter exact rather than a substring match.
 */
async function containerId(rt: ContainerRuntime, includeStopped: boolean): Promise<string | null> {
    const args = ["ps", ...(includeStopped ? ["-a"] : []), "-q", "-f", `name=^${CONTAINER_NAME}$`];
    const { code, stdout } = await capture(rt, args);
    if (code !== 0) return null;
    const id = stdout.trim();
    return id.length > 0 ? id : null;
}

async function isProxyRunning(rt: ContainerRuntime): Promise<boolean> {
    return (await containerId(rt, false)) !== null;
}

function volumeArgs(rt: ContainerRuntime): string[] {
    // Bind config.yaml and the auth dir from our data dir into the container.
    // rt.mountArg adds Podman's `:z` relabel; Docker gets the bare form.
    return ["-v", rt.mountArg(env.cliproxyConfigPath, CONTAINER_CONFIG_PATH), "-v", rt.mountArg(env.cliproxyAuthDir, CONTAINER_AUTH_DIR)];
}

async function removeContainer(rt: ContainerRuntime): Promise<void> {
    await capture(rt, ["rm", "-f", CONTAINER_NAME]);
}

/**
 * (Re)create the long-running proxy container. Recreating (vs reusing) applies
 * the current image and mount flags every time setup runs.
 */
async function recreateContainer(rt: ContainerRuntime): Promise<void> {
    await removeContainer(rt);
    const args = [
        "run",
        "-d",
        "--name",
        CONTAINER_NAME,
        // TODO(robustness): Podman is daemonless, so `unless-stopped` does not
        // survive a host reboot without systemd/quadlets integration. The proxy
        // still auto-starts within a session via ensureContainerRunning().
        "--restart",
        "unless-stopped",
        "-p",
        `${env.cliproxyPort}:${env.cliproxyPort}`,
        ...volumeArgs(rt),
        IMAGE,
    ];
    const { code, stderr } = await capture(rt, args);
    if (code !== 0) throw new ProxyError(`Failed to start the proxy container.${stderr ? `\n  ${stderr.trim()}` : ""}`);
}

async function startProxy(rt: ContainerRuntime): Promise<void> {
    await recreateContainer(rt);
    console.log(`\n  CLIProxyAPI is running on ${env.cliproxyBaseUrl}`);
}

/**
 * Bring the container up without forcing a recreate: reuse a running one, start
 * a stopped one, or create it if absent. Used on the TUI hot path.
 */
async function ensureContainerRunning(rt: ContainerRuntime): Promise<void> {
    if (await isProxyRunning(rt)) return;
    if ((await containerId(rt, true)) !== null) {
        const { code, stderr } = await capture(rt, ["start", CONTAINER_NAME]);
        if (code !== 0) throw new ProxyError(`Failed to start the proxy container.${stderr ? `\n  ${stderr.trim()}` : ""}`);
        return;
    }
    await recreateContainer(rt);
}

// --- config ----------------------------------------------------------------

async function writeProxyConfig(): Promise<{ created: boolean; apiKey?: string }> {
    // 0o700/0o600: this dir holds the client API key and provider credentials.
    // (Modes are a no-op on Windows, which is acceptable.)
    await mkdir(dirname(env.cliproxyConfigPath), { recursive: true, mode: 0o700 });
    await mkdir(env.cliproxyAuthDir, { recursive: true, mode: 0o700 });

    if (await Bun.file(env.cliproxyConfigPath).exists()) return { created: false };

    const apiKey = generateApiKey();
    await writeFile(env.cliproxyConfigPath, proxyConfig(apiKey), { mode: 0o600 });
    return { created: true, apiKey };
}

/**
 * auth-dir is the in-container Linux path (mounted from env.cliproxyAuthDir), so
 * it is OS-safe regardless of the host.
 */
function proxyConfig(apiKey: string): string {
    return `host: ""
port: ${env.cliproxyPort}
auth-dir: "${CONTAINER_AUTH_DIR}"
api-keys:
  - "${apiKey}"
debug: false
`;
}

/**
 * Client-facing key for calling the proxy — distinct from the provider
 * credentials the login flows write under auth-dir.
 */
function generateApiKey(): string {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const rand = new Uint8Array(45);
    crypto.getRandomValues(rand);
    let key = "sk-";
    for (const b of rand) key += chars[b % chars.length];
    return key;
}

// --- authentication --------------------------------------------------------

/**
 * Authenticated == the proxy has written at least one credential file into the
 * mounted auth dir.
 */
async function isAuthenticated(): Promise<boolean> {
    return readdir(env.cliproxyAuthDir).then(
        (entries) => entries.some((name) => !name.startsWith(".")),
        () => false,
    );
}

/**
 * Run the proxy's OAuth flow in a throwaway container that shares our auth-dir
 * mount, so credentials persist on the host. stdio is inherited so the user
 * interacts directly; `--no-browser` prints the URL instead of trying (and
 * failing) to launch a browser from inside the container.
 */
async function runProviderLogin(rt: ContainerRuntime, provider: Provider): Promise<void> {
    const port = PROVIDER_CALLBACK_PORT[provider];
    const tty = process.stdin.isTTY ? ["-t"] : [];
    const publish = port === null ? [] : ["-p", `${port}:${port}`];
    const args = ["run", "--rm", "-i", ...tty, ...volumeArgs(rt), ...publish, IMAGE, CONTAINER_BINARY, PROVIDER_LOGIN_FLAG[provider], "--no-browser"];

    console.log(`\n  Authenticating ${PROVIDER_LABEL[provider]} — open the printed URL in your browser…`);
    const code = await inherit(rt, args);
    if (code !== 0) console.log(`  ${PROVIDER_LABEL[provider]} login exited with code ${code}; you can retry with \`inf setup\`.`);
}

/**
 * Returns the provider to authenticate, or null to skip. A non-interactive
 * terminal can't drive the prompt, so it skips rather than hanging.
 */
async function chooseProvider(preselected: Provider | undefined): Promise<Provider | null> {
    if (preselected) return preselected;
    if (!process.stdin.isTTY) return null;

    console.log("\n  Authenticate a provider (opens a browser):");
    for (const [i, p] of PROVIDERS.entries()) console.log(`    ${i + 1}) ${PROVIDER_LABEL[p]}`);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`\n  Select 1-${PROVIDERS.length}, or Enter to skip: `)).trim();
    rl.close();

    if (answer === "") return null;
    const chosen = PROVIDERS[Number(answer) - 1];
    if (!chosen) {
        console.log("  Skipping auth (no valid selection).");
        return null;
    }
    return chosen;
}

/**
 * Prompt (unless preselected) and run the login. Returns whether the proxy is
 * authenticated afterwards.
 */
async function authenticate(rt: ContainerRuntime, preselected: Provider | undefined): Promise<boolean> {
    const chosen = await chooseProvider(preselected);
    if (chosen) await runProviderLogin(rt, chosen);
    return isAuthenticated();
}

// --- shared entry used by the TUI ------------------------------------------

/**
 * Make the proxy ready to serve the TUI: runtime up, image present, config
 * written, authenticated, container running. Throws ProxyError /
 * ContainerRuntimeError with actionable guidance when it can't proceed (e.g.
 * the runtime isn't ready, or auth is needed in a non-interactive shell).
 */
export async function ensureProxyReady(): Promise<void> {
    const rt = activeRuntime();
    await ensureReady(rt);
    await writeProxyConfig();
    await pullImage(rt, false);

    if (!(await isAuthenticated())) {
        if (!process.stdin.isTTY) {
            throw new ProxyError("CLIProxyAPI isn't authenticated yet.\n  Run `inf setup` to sign in to a provider before starting the TUI.");
        }
        console.log("\n  CLIProxyAPI isn't authenticated yet — let's sign in.");
        if (!(await authenticate(rt, undefined))) {
            throw new ProxyError("Authentication didn't complete.\n  Run `inf setup` to finish signing in, then try again.");
        }
    }

    await ensureContainerRunning(rt);
}

/**
 * The exit-on-error variant of {@link ensureProxyReady} for the TUI launch path: print
 * actionable guidance and exit non-zero rather than throwing, since the renderer is about to
 * take over the terminal. The auth flow inside needs normal stdio, so callers must invoke this
 * BEFORE render().
 */
export async function ensureProxyReadyOrExit(): Promise<void> {
    try {
        await ensureProxyReady();
    } catch (error) {
        if (error instanceof ProxyError || error instanceof ContainerRuntimeError) {
            console.error(`\n  ${error.message}\n`);
        } else {
            console.error("\n  Could not start CLIProxyAPI:", error, "\n");
        }
        process.exit(1);
    }
}
