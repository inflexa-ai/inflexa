import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { signInToMcpServer } from "@inflexa-ai/harness";
import { ok } from "neverthrow";

import type { Config } from "../lib/config.ts";
import { DEFAULT_THEME_ID } from "../lib/design_system.ts";
import { createCredentialReader } from "../modules/customization/credentials.ts";
import type { FoundMcpServer, RegistryOpts } from "../modules/customization/mcp_sources.ts";
import { createMcpTokenStore, type McpTokenStore } from "../modules/customization/mcp_tokens.ts";
import type { SecretStore } from "../modules/customization/secret_store.ts";
import type { CustomizationOpts } from "../modules/customization/service.ts";

/** The customization state of one test: temporary directories, a config in memory, and a token file. */
export type CustomizationFixture = {
    readonly root: string;
    readonly agentsDir: string;
    readonly userSkillsDir: string;
    readonly builtinSkillsDir: string;
    readonly tokenStore: McpTokenStore;
    /** The stored credential values, by name. */
    readonly secrets: Map<string, string>;
    /** The MCP servers that the configs of other harnesses hold. */
    found: FoundMcpServer[];
    /** The answer of the MCP Registry to each path. Absent: 404. */
    readonly registry: Map<string, unknown>;
    /** The usual skill directories of other harnesses. */
    readonly skillDirs: string[];
    /** The URLs that the service asked the browser to open. */
    readonly opened: URL[];
    config: Config;
    opts: CustomizationOpts;
};

/** Write a skill directory with a valid `SKILL.md`. */
export function writeSkill(root: string, name: string, description: string = `The ${name} skill.`): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nThe body of ${name}.\n`);
    return dir;
}

/**
 * A fresh {@link CustomizationFixture}. The built-in skills root holds `single-cell` and `omics-general`. The token
 * store is the file store of a platform with no Keychain, thus no test touches the Keychain of the machine.
 */
export function customizationFixture(): CustomizationFixture {
    const root = mkdtempSync(join(tmpdir(), "inflexa-customization-"));
    const builtinSkillsDir = join(root, "builtin-skills");
    writeSkill(builtinSkillsDir, "single-cell");
    writeSkill(builtinSkillsDir, "omics-general");
    const agentsDir = join(root, "agents");
    const userSkillsDir = join(root, "skills");
    const tokenStore = createMcpTokenStore({ platform: "linux", filePath: join(root, "mcp-tokens.json") });
    const opened: URL[] = [];
    const secrets = new Map<string, string>();
    const credentialStore: SecretStore = {
        read: (account) => Promise.resolve(secrets.get(account)),
        write: (account, value) => {
            secrets.set(account, value);
            return Promise.resolve();
        },
        remove: (account) => {
            secrets.delete(account);
            return Promise.resolve();
        },
    };
    const registryAnswers = new Map<string, unknown>();
    const registry: RegistryOpts = {
        baseUrl: "https://registry.test",
        fetch: (input) => {
            const answer = registryAnswers.get(input.slice("https://registry.test".length));
            return Promise.resolve(answer === undefined ? new Response("not found", { status: 404 }) : Response.json(answer));
        },
    };
    const skillDirs = [join(root, "claude-skills"), join(root, "codex-skills")];
    const fixture: CustomizationFixture = {
        root,
        agentsDir,
        userSkillsDir,
        builtinSkillsDir,
        tokenStore,
        secrets,
        found: [],
        registry: registryAnswers,
        skillDirs,
        opened,
        config: { telemetry: false, theme: DEFAULT_THEME_ID, leaderTimeout: 2000, embedding: { mode: "off" } },
        opts: {
            agentsDir,
            userSkillsDir,
            builtinSkillsDir: () => builtinSkillsDir,
            readConfig: () => fixture.config,
            writeConfig: (config) => {
                fixture.config = config;
                return ok(undefined);
            },
            credentials: createCredentialReader({ declarations: () => fixture.config.credentials, stored: credentialStore }),
            credentialStore,
            tokenStore,
            findMcpServers: () => fixture.found,
            registry,
            skillDirs,
            openBrowser: (url) => {
                opened.push(url);
            },
            signIn: signInToMcpServer,
            // A test that revokes at a server sets the real revocation and a local OAuth server.
            revoke: () => Promise.resolve({ status: "no_endpoint" }),
            authTimeoutMs: 60_000,
        },
    };
    return fixture;
}

/** Write an agent file of the agents directory. */
export function writeAgentFile(fixture: CustomizationFixture, id: string, text: string): string {
    mkdirSync(fixture.agentsDir, { recursive: true });
    const path = join(fixture.agentsDir, `${id}.md`);
    writeFileSync(path, text);
    return path;
}
