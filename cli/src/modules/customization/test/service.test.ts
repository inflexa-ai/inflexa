import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BUILTIN_AGENTS, revokeMcpSignIn, type McpAuthorizationCallback } from "@inflexa-ai/harness";
import { startMcpOAuthFixture } from "@inflexa-ai/harness/testing";
import { beforeEach, describe, expect, test } from "bun:test";

import type { McpEntryView } from "../../../api/customization.ts";
import { messageOf } from "../../../lib/cause.ts";
import { clearEnvVars } from "../../../test_support/env_vars.ts";
import { customizationFixture, writeAgentFile, writeSkill, type CustomizationFixture } from "../../../test_support/customization.ts";
import { awaitOk } from "../../../test_support/result.ts";
import { splitFrontmatter } from "../agent_files.ts";
import { createMcpOAuthProvider } from "../mcp_tokens.ts";
import { createCustomizationService, type CustomizationService } from "../service.ts";

let fixture: CustomizationFixture;
let service: CustomizationService;

beforeEach(() => {
    fixture = customizationFixture();
    service = createCustomizationService(fixture.opts);
});

const LIMS: McpEntryView = { type: "stdio", command: "lims-mcp", args: [], env: {}, approval: "never", scriptable: false, enabled: true };

function frontmatterOf(path: string): unknown {
    const split = splitFrontmatter(readFileSync(path, "utf8"));
    return split === null ? null : Bun.YAML.parse(split.yaml);
}

describe("listAgents and showAgent", () => {
    test("each built-in agent, each custom agent, and each draft with its gaps", async () => {
        writeAgentFile(fixture, "lipid-analyst", "---\nname: lipid-analyst\ndescription: Lipids.\nconnectors: [pubmed]\n---\nThe prompt.\n");
        writeAgentFile(fixture, "broken", "---\nname: broken\ndescription: Broken.\nmcpServers: [lipidmaps]\n---\nThe prompt.\n");

        const agents = await awaitOk(service.listAgents());

        expect(agents.slice(0, BUILTIN_AGENTS.length).map((agent) => agent.id)).toEqual(BUILTIN_AGENTS.map((agent) => agent.id));
        expect(agents.find((agent) => agent.id === "analyst")).toMatchObject({
            kind: "builtin",
            draft: false,
            role: "executor",
            enabled: true,
            canDisable: false,
        });
        expect(agents.find((agent) => agent.id === "lipid-analyst")).toMatchObject({
            kind: "custom",
            draft: false,
            enabled: true,
            attachments: { connectors: ["pubmed"] },
        });
        expect(agents.find((agent) => agent.id === "broken")).toMatchObject({
            kind: "custom",
            draft: true,
            gaps: [{ reason: "unknown_mcp_server", reference: "lipidmaps" }],
        });
    });

    test("a built-in agent shows the release defaults, the change of the user, and the resolved attachments", async () => {
        fixture.config = { ...fixture.config, mcp: { lims: LIMS }, agents: { analyst: { add: { mcp: ["lims"] } } } };

        const analyst = await awaitOk(service.showAgent("analyst"));

        const builtin = BUILTIN_AGENTS.find((agent) => agent.id === "analyst");
        expect(analyst.defaults?.skills).toEqual([...(builtin?.defaults.skills ?? [])]);
        expect(analyst.change?.add.mcp).toEqual(["lims"]);
        expect(analyst.attachments.mcp).toEqual(["lims"]);
        expect(analyst.prompt).toBe(builtin?.prompt ?? null);
    });

    test("a file whose frontmatter does not parse is a draft with the parse error", async () => {
        writeAgentFile(fixture, "bad", "---\nname: [unclosed\n---\nbody\n");

        const bad = await awaitOk(service.showAgent("bad"));

        expect(bad).toMatchObject({ draft: true, gaps: [{ reason: "invalid_yaml" }] });
    });

    test("an unknown id is `unknown_agent`", async () => {
        expect((await service.showAgent("nope"))._unsafeUnwrapErr()).toEqual({ type: "unknown_agent", id: "nope" });
    });
});

describe("attach and detach", () => {
    test("an attach to a built-in agent writes only the difference from the defaults", async () => {
        writeSkill(fixture.userSkillsDir, "lab-protocols");

        await awaitOk(service.attach("analyst", "skill", "lab-protocols"));

        expect(fixture.config.agents).toEqual({ analyst: { add: { skills: ["lab-protocols"] } } });
    });

    test("a server that asks approval attaches to the chat agent, and an agent that no person answers refuses it", async () => {
        fixture.config = { ...fixture.config, mcp: { lims: { ...LIMS, approval: "always" } } };

        await awaitOk(service.attach("inflexa", "mcp", "lims"));

        expect((await service.attach("analyst", "mcp", "lims"))._unsafeUnwrapErr()).toEqual({ type: "approval_needs_a_person", id: "analyst", name: "lims" });
        expect((await service.attach("planner", "mcp", "lims"))._unsafeUnwrapErr()).toEqual({ type: "approval_needs_a_person", id: "planner", name: "lims" });
        expect(fixture.config.agents).toEqual({ inflexa: { add: { mcp: ["lims"] } } });
    });

    test("a detach of a default writes `remove`, and an attach of it again clears the entry", async () => {
        const detached = await awaitOk(service.detach("analyst", "skill", "single-cell"));
        expect(fixture.config.agents).toEqual({ analyst: { remove: { skills: ["single-cell"] } } });
        expect(detached.attachments.skills).not.toContain("single-cell");

        await awaitOk(service.attach("analyst", "skill", "single-cell"));
        expect(fixture.config.agents).toBeUndefined();
    });

    test("an attach of an unknown reference is refused", async () => {
        expect((await service.attach("analyst", "mcp", "lims"))._unsafeUnwrapErr()).toEqual({ type: "unknown_reference", kind: "mcp", name: "lims" });
        expect((await service.attach("analyst", "connector", "no-such"))._unsafeUnwrapErr()).toEqual({
            type: "unknown_reference",
            kind: "connector",
            name: "no-such",
        });
    });

    test("an attach to a custom agent rewrites its frontmatter list and keeps each other field and the prompt", async () => {
        fixture.config = { ...fixture.config, mcp: { lims: LIMS } };
        const path = writeAgentFile(
            fixture,
            "lipid-analyst",
            "---\nname: lipid-analyst\ndescription: Lipids.\nmodel: opus\nconnectors: [pubmed]\n---\nThe prompt.\n",
        );

        const agent = await awaitOk(service.attach("lipid-analyst", "mcp", "lims"));

        expect(frontmatterOf(path)).toEqual({ name: "lipid-analyst", description: "Lipids.", model: "opus", connectors: ["pubmed"], mcpServers: ["lims"] });
        expect(readFileSync(path, "utf8").endsWith("\n\nThe prompt.\n")).toBe(true);
        expect(agent.attachments.mcp).toEqual(["lims"]);

        await awaitOk(service.detach("lipid-analyst", "connector", "pubmed"));
        expect(frontmatterOf(path)).toMatchObject({ connectors: [] });
    });
});

describe("enable and disable", () => {
    test("an agent that must stay on cannot be turned off", async () => {
        expect((await service.setAgentEnabled("analyst", false))._unsafeUnwrapErr()).toEqual({ type: "cannot_disable", id: "analyst" });
        expect(fixture.config.agents).toBeUndefined();
    });

    test("a built-in agent that can be off is turned off and on again", async () => {
        const off = await awaitOk(service.setAgentEnabled("drug-analyst", false));
        expect(off.enabled).toBe(false);
        expect(fixture.config.agents).toEqual({ "drug-analyst": { enabled: false } });

        const on = await awaitOk(service.setAgentEnabled("drug-analyst", true));
        expect(on.enabled).toBe(true);
        expect(fixture.config.agents).toBeUndefined();
    });

    test("a custom agent is turned off in the config", async () => {
        writeAgentFile(fixture, "mine", "---\nname: mine\ndescription: Mine.\n---\nThe prompt.\n");

        expect((await awaitOk(service.setAgentEnabled("mine", false))).enabled).toBe(false);
        expect(fixture.config.agents).toEqual({ mine: { enabled: false } });
    });
});

describe("clone", () => {
    test("a clone of the analyst holds its prompt and its attachments with the change of the user", async () => {
        fixture.config = { ...fixture.config, mcp: { lims: LIMS }, agents: { analyst: { add: { mcp: ["lims"] } } } };

        const clone = await awaitOk(service.cloneAgent("analyst", "my-analyst"));

        const path = join(fixture.agentsDir, "my-analyst.md");
        expect(clone).toMatchObject({ id: "my-analyst", kind: "custom", path });
        expect(frontmatterOf(path)).toMatchObject({ name: "my-analyst", role: "executor", mcpServers: ["lims"] });
        expect(readFileSync(path, "utf8")).toContain((BUILTIN_AGENTS.find((agent) => agent.id === "analyst")?.prompt ?? "<none>").trim());
    });

    test("a built-in executor that the user turned off can still be cloned", async () => {
        fixture.config = { ...fixture.config, agents: { "drug-analyst": { enabled: false } } };

        expect(await awaitOk(service.cloneAgent("drug-analyst", "my-drugs"))).toMatchObject({ id: "my-drugs", kind: "custom" });
        expect(existsSync(join(fixture.agentsDir, "my-drugs.md"))).toBe(true);
    });

    test("an id that exists, an id that is not clean, and a role that is not an executor are refused", async () => {
        await awaitOk(service.cloneAgent("analyst", "copy"));
        expect((await service.cloneAgent("analyst", "copy"))._unsafeUnwrapErr()).toEqual({ type: "agent_exists", id: "copy" });
        expect((await service.cloneAgent("analyst", "planner"))._unsafeUnwrapErr()).toEqual({ type: "agent_exists", id: "planner" });
        expect((await service.cloneAgent("analyst", "Bad Id"))._unsafeUnwrapErr()).toEqual({ type: "invalid_agent_id", id: "Bad Id" });
        expect((await service.cloneAgent("planner", "my-planner"))._unsafeUnwrapErr()).toEqual({ type: "not_an_executor", id: "planner" });
        expect((await service.cloneAgent("nope", "my-nope"))._unsafeUnwrapErr()).toEqual({ type: "unknown_agent", id: "nope" });
    });
});

describe("import", () => {
    test("a Claude Code file maps its MCP tools, drops the role tools and the model, and keeps an unknown tool as a draft gap", async () => {
        fixture.config = { ...fixture.config, mcp: { github: LIMS } };
        const source = join(fixture.root, "reviewer.md");
        writeFileSync(
            source,
            "---\nname: Reviewer\ndescription: Reviews code.\ntools: Read, Bash, mcp__github__search_code, NotebookEdit\nmodel: sonnet\n---\nReview it.\n",
        );

        const agent = await awaitOk(service.importAgent(source));

        const path = join(fixture.agentsDir, "reviewer.md");
        expect(frontmatterOf(path)).toEqual({
            name: "reviewer",
            description: "Reviews code.",
            role: "executor",
            connectors: [],
            mcpServers: ["github"],
            skills: [],
            tools: ["NotebookEdit"],
        });
        expect(agent).toMatchObject({ id: "reviewer", draft: true, gaps: [{ reason: "tool_not_mapped", reference: "NotebookEdit" }] });
        expect((await service.importAgent(source))._unsafeUnwrapErr()).toEqual({ type: "agent_exists", id: "reviewer" });
    });

    test("a file that does not exist is `import_failed`", async () => {
        expect((await service.importAgent(join(fixture.root, "absent.md")))._unsafeUnwrapErr()).toMatchObject({ type: "import_failed" });
    });
});

describe("removeAgent", () => {
    test("a custom agent loses its file and its config entry", async () => {
        const path = writeAgentFile(fixture, "mine", "---\nname: mine\ndescription: Mine.\n---\nThe prompt.\n");
        fixture.config = { ...fixture.config, agents: { mine: { enabled: false } } };

        await awaitOk(service.removeAgent("mine"));

        expect(existsSync(path)).toBe(false);
        expect(fixture.config.agents).toBeUndefined();
    });

    test("a built-in agent is refused", async () => {
        expect((await service.removeAgent("analyst"))._unsafeUnwrapErr()).toEqual({ type: "builtin_agent", id: "analyst" });
    });
});

describe("skills", () => {
    test("a custom skill is listed beside the built-in skills, and a collision names the built-in skill", async () => {
        writeSkill(fixture.userSkillsDir, "lab-protocols");
        writeSkill(fixture.userSkillsDir, "single-cell");

        const list = await awaitOk(service.listSkills());

        expect(list.skills.map((skill) => [skill.name, skill.kind])).toEqual([
            ["omics-general", "builtin"],
            ["single-cell", "builtin"],
            ["lab-protocols", "custom"],
        ]);
        expect(list.problems).toEqual([
            {
                directory: join(fixture.userSkillsDir, "single-cell"),
                kind: "custom",
                message: `The name "single-cell" belongs to the built-in skill at ${join(fixture.builtinSkillsDir, "single-cell")}. The agents read the built-in skill.`,
            },
        ]);
    });

    test("find lists the skills of a named directory, and a skill directory itself, with each conflict", async () => {
        const found = join(fixture.root, "found");
        writeSkill(found, "plate-reader");
        writeSkill(found, "single-cell");

        const list = await awaitOk(service.findSkills(found));
        expect(list.skills.map((skill) => [skill.name, skill.conflict ?? null])).toEqual([
            ["plate-reader", null],
            ["single-cell", 'A built-in skill "single-cell" exists already.'],
        ]);

        const one = await awaitOk(service.findSkills(join(found, "plate-reader")));
        expect(one.skills.map((skill) => skill.name)).toEqual(["plate-reader"]);
        expect((await service.findSkills(join(fixture.root, "absent")))._unsafeUnwrapErr()).toEqual({
            type: "skill_dir_missing",
            path: join(fixture.root, "absent"),
        });
    });

    test("import copies a skill directory, and refuses a built-in name and a name that exists", async () => {
        const source = writeSkill(join(fixture.root, "found"), "plate-reader");
        mkdirSync(join(source, "references"));
        writeFileSync(join(source, "references", "notes.md"), "notes");

        const skill = await awaitOk(service.importSkill(source));

        expect(skill).toEqual({
            name: "plate-reader",
            description: "The plate-reader skill.",
            kind: "custom",
            directory: join(fixture.userSkillsDir, "plate-reader"),
        });
        expect(readFileSync(join(fixture.userSkillsDir, "plate-reader", "references", "notes.md"), "utf8")).toBe("notes");
        expect((await service.importSkill(source))._unsafeUnwrapErr()).toEqual({ type: "skill_exists", name: "plate-reader", builtin: false });
        const builtinName = writeSkill(join(fixture.root, "other"), "single-cell");
        expect((await service.importSkill(builtinName))._unsafeUnwrapErr()).toEqual({ type: "skill_exists", name: "single-cell", builtin: true });
    });
});

describe("connectors and credentials", () => {
    const VAR = "INFLEXA_TEST_CUSTOMIZATION_NCBI";

    test("a slot names a credential, and the list says if it resolves, never the value", async () => {
        const restore = clearEnvVars(Bun.env, [VAR]);
        try {
            await awaitOk(service.setCredential("ncbi-key", { kind: "env", var: VAR }));
            const connector = await awaitOk(service.setConnector("pubmed", { credentials: { ncbi: "ncbi-key" }, endpoint: "https://ncbi.example" }));
            expect(fixture.config.connectors).toEqual({ pubmed: { endpoint: "https://ncbi.example", credentials: { ncbi: "ncbi-key" } } });
            expect(connector.slots).toEqual([{ slot: "ncbi", required: false, credential: "ncbi-key", resolves: false }]);

            Bun.env[VAR] = "secret-value";
            const listed = await awaitOk(service.listConnectors());
            expect(listed.find((item) => item.id === "pubmed")?.slots[0]?.resolves).toBe(true);
            const credentials = await awaitOk(service.listCredentials());
            expect(credentials).toEqual([{ name: "ncbi-key", source: { kind: "env", var: VAR }, resolves: true }]);
            expect(JSON.stringify(credentials)).not.toContain("secret-value");

            await awaitOk(service.setConnector("pubmed", { credentials: { ncbi: null }, endpoint: null }));
            expect(fixture.config.connectors).toBeUndefined();
        } finally {
            restore();
        }
    });

    test("an unknown connector, an unknown slot, and a bad credential name are refused", async () => {
        expect((await service.setConnector("nope", {}))._unsafeUnwrapErr()).toEqual({ type: "unknown_connector", id: "nope" });
        expect((await service.setConnector("pubmed", { credentials: { other: "x" } }))._unsafeUnwrapErr()).toEqual({
            type: "unknown_slot",
            id: "pubmed",
            slot: "other",
        });
        expect((await service.setCredential("Bad Name", { kind: "env", var: "X" }))._unsafeUnwrapErr()).toEqual({
            type: "invalid_credential_name",
            name: "Bad Name",
        });
    });

    test("a connector turned off keeps only `enabled: false`", async () => {
        expect((await awaitOk(service.setConnector("geo", { enabled: false }))).enabled).toBe(false);
        expect(fixture.config.connectors).toEqual({ geo: { enabled: false } });
    });
});

describe("MCP servers", () => {
    const REMOTE = { type: "http", url: "https://mcp.example/mcp", auth: "oauth" } as const;
    const TOKENS = { access_token: "a", token_type: "Bearer" };

    test("add validates the name and the entry, fills the defaults, and refuses a name that exists", async () => {
        expect((await service.addMcp("lab.lims", LIMS))._unsafeUnwrapErr()).toEqual({ type: "invalid_mcp_name", name: "lab.lims" });
        expect((await service.addMcp("lims", { type: "stdio" }))._unsafeUnwrapErr()).toMatchObject({ type: "invalid_mcp_entry" });

        const added = await awaitOk(service.addMcp("lims", { type: "stdio", command: "lims-mcp" }));

        expect(added).toEqual({ name: "lims", entry: LIMS });
        expect(fixture.config.mcp).toEqual({ lims: LIMS });
        expect((await service.addMcp("lims", LIMS))._unsafeUnwrapErr()).toEqual({ type: "mcp_server_exists", name: "lims" });
    });

    test("the list shows an invalid entry with its problem, and the sign-in state of an OAuth server", async () => {
        fixture.config = { ...fixture.config, mcp: { remote: REMOTE, bad: { type: "ftp" } } };
        await fixture.tokenStore.write(REMOTE.url, { tokens: TOKENS });

        const servers = await awaitOk(service.listMcp());

        expect(servers[0]).toEqual({ name: "remote", entry: { ...REMOTE, headers: {}, approval: "never", scriptable: false, enabled: true }, signedIn: true });
        expect(servers.slice(1).map((server) => [server.name, "problem" in server])).toEqual([["bad", true]]);
    });

    test("disable writes `enabled: false`, and rm deletes the entry and the tokens of its URL", async () => {
        await awaitOk(service.addMcp("remote", REMOTE));
        await fixture.tokenStore.write(REMOTE.url, { tokens: TOKENS, clientInformation: { client_id: "c" } });

        expect(await awaitOk(service.setMcpEnabled("remote", false))).toMatchObject({ entry: { enabled: false } });
        await awaitOk(service.removeMcp("remote"));

        expect(fixture.config.mcp).toBeUndefined();
        expect(await fixture.tokenStore.read(REMOTE.url)).toBeUndefined();
        expect((await service.removeMcp("remote"))._unsafeUnwrapErr()).toEqual({ type: "unknown_mcp_server", name: "remote" });
    });

    test("auth takes the code from the loopback callback, stores the tokens, and stops the listener", async () => {
        fixture.config = { ...fixture.config, mcp: { remote: REMOTE } };
        const seen: McpAuthorizationCallback[] = [];
        let redirect = "";
        let browser: Promise<Response> | undefined;
        service = createCustomizationService({
            ...fixture.opts,
            // The authorization server of the test: it sends the browser to the redirect URL with a code.
            openBrowser: (url) => {
                fixture.opened.push(url);
                browser = fetch(`${redirect}?code=the-code&iss=https%3A%2F%2Fauth.example`);
            },
            signIn: async ({ provider, waitForCallback }) => {
                redirect = String(provider.redirectUrl);
                await provider.redirectToAuthorization(new URL("https://auth.example/authorize"));
                const callback = await waitForCallback();
                seen.push(callback);
                await provider.saveTokens(TOKENS);
                return { status: "authorized" };
            },
        });

        await awaitOk(service.mcpAuth("remote"));

        expect(fixture.opened.map(String)).toEqual(["https://auth.example/authorize"]);
        expect(await (await browser)?.text()).toBe("The sign-in is complete. You can close this page.");
        expect(seen).toEqual([{ code: "the-code", iss: "https://auth.example" }]);
        expect((await fixture.tokenStore.read(REMOTE.url))?.tokens).toEqual(TOKENS);
        const callbackUrl = new URL(redirect);
        expect([callbackUrl.hostname, callbackUrl.pathname]).toEqual(["127.0.0.1", "/callback"]);
        expect(await fetch(redirect).catch(() => "closed")).toBe("closed");
    });

    test("against a local OAuth server: auth signs in, a tool call reads the tokens, and logout revokes them, then deletes them", async () => {
        const oauth = await startMcpOAuthFixture();
        try {
            fixture.config = { ...fixture.config, mcp: { remote: { type: "http", url: oauth.url, auth: "oauth" } } };
            service = createCustomizationService({
                ...fixture.opts,
                // The browser: the authorization page of the fixture grants at once and redirects to the loopback callback.
                openBrowser: (url) => void fetch(url),
                revoke: revokeMcpSignIn,
            });

            await awaitOk(service.mcpAuth("remote"));

            // The provider of a tool call reads the stored tokens with no browser.
            const forCalls = createMcpOAuthProvider({ server: "remote", url: oauth.url, store: fixture.tokenStore });
            expect((await forCalls.tokens())?.access_token).toBe("access-1");
            const call = await fetch(oauth.url, {
                method: "POST",
                headers: { authorization: "Bearer access-1", "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami" } }),
            });
            expect(call.status).toBe(200);

            expect(await awaitOk(service.mcpLogout("remote"))).toEqual({ status: "revoked" });
            expect(oauth.revoked).toEqual(["refresh-1", "access-1"]);
            expect(await fixture.tokenStore.read(oauth.url)).toBeUndefined();
        } finally {
            await oauth.close();
        }
    });

    test("auth fails when no browser comes back before the timeout", async () => {
        fixture.config = { ...fixture.config, mcp: { remote: REMOTE } };
        service = createCustomizationService({
            ...fixture.opts,
            authTimeoutMs: 20,
            signIn: async ({ waitForCallback }) => {
                try {
                    await waitForCallback();
                    return { status: "authorized" };
                } catch (cause) {
                    return { status: "failed", reason: messageOf(cause) };
                }
            },
        });

        expect((await service.mcpAuth("remote"))._unsafeUnwrapErr()).toMatchObject({ type: "sign_in_failed", name: "remote" });
    });

    test("auth and logout refuse a server that does not sign in with OAuth, and logout deletes the tokens", async () => {
        fixture.config = { ...fixture.config, mcp: { lims: LIMS, remote: REMOTE } };
        await fixture.tokenStore.write(REMOTE.url, { tokens: TOKENS });

        expect((await service.mcpAuth("lims"))._unsafeUnwrapErr()).toEqual({ type: "not_oauth", name: "lims" });
        expect((await service.mcpLogout("lims"))._unsafeUnwrapErr()).toEqual({ type: "not_oauth", name: "lims" });
        expect(await awaitOk(service.mcpLogout("remote"))).toEqual({ status: "no_endpoint" });
        expect(await fixture.tokenStore.read(REMOTE.url)).toBeUndefined();
    });
});
