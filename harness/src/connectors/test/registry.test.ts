import { describe, expect, it } from "bun:test";

import { BUILTIN_AGENTS } from "../../catalog/builtins.js";
import { createInMemoryCatalog } from "../../catalog/memory.js";
import { resolveCatalog } from "../../catalog/resolve.js";
import type { CitationResolver } from "../../citations/types.js";
import { buildConnectorTools, liveSourcesOf } from "../build.js";
import { CONNECTORS, CONNECTOR_IDS } from "../registry.js";

const fakeResolver: CitationResolver = {
    resolveOne: () => Promise.reject(new Error("unused")),
    resolveMany: () => Promise.reject(new Error("unused")),
};

describe("connector registry", () => {
    it("gives each tool to exactly one connector", () => {
        const owners = new Map<string, string[]>();
        for (const connector of CONNECTORS.values()) {
            for (const tool of connector.tools({ credential: () => undefined, endpoint: "http://127.0.0.1:1", citationResolver: fakeResolver })) {
                owners.set(tool.id, [...(owners.get(tool.id) ?? []), connector.id]);
            }
        }
        for (const [tool, connectors] of owners) expect({ tool, connectors }).toEqual({ tool, connectors: [connectors[0] ?? ""] });
    });

    it("lets each default connector of each built-in agent resolve", () => {
        for (const agent of BUILTIN_AGENTS) {
            for (const id of agent.defaults.connectors)
                expect({ agent: agent.id, id, known: CONNECTORS.has(id) }).toEqual({ agent: agent.id, id, known: true });
        }
    });

    it("keeps the ids unique", () => {
        expect(new Set(CONNECTOR_IDS).size).toBe(CONNECTOR_IDS.length);
    });

    it("names the live lookups of the built-in executors", () => {
        const analyst = BUILTIN_AGENTS.find((agent) => agent.id === "analyst")?.defaults.connectors ?? [];
        const drugAnalyst = BUILTIN_AGENTS.find((agent) => agent.id === "drug-analyst")?.defaults.connectors ?? [];
        for (const source of ["gnomAD", "HumanBase tissue networks", "MyGene.info"]) expect(liveSourcesOf(analyst)).toContain(source);
        for (const source of ["ChEMBL", "FAERS"]) expect(liveSourcesOf(drugAnalyst)).toContain(source);
    });
});

describe("buildConnectorTools", () => {
    it("gives every tool of an attached connector and nothing else", async () => {
        const catalog = createInMemoryCatalog();
        const tools = await buildConnectorTools(catalog, await resolveCatalog(catalog), ["context7", "chembl"], {});
        expect(tools.map((tool) => tool.id).sort()).toEqual(["chembl", "query_docs", "resolve_library_id"]);
    });

    it("leaves out a disabled connector", async () => {
        const catalog = createInMemoryCatalog({ connectors: [{ id: "chembl", enabled: false }] });
        const tools = await buildConnectorTools(catalog, await resolveCatalog(catalog), ["chembl", "pubchem"], {});
        expect(tools.map((tool) => tool.id)).toEqual(["pubchem"]);
    });

    it("reads one credential for two connectors that name it", async () => {
        const read: string[] = [];
        const base = createInMemoryCatalog({ credentials: { amass: "secret" } });
        const catalog = {
            ...base,
            credential: (name: string) => {
                read.push(name);
                return base.credential(name);
            },
        };
        await buildConnectorTools(catalog, await resolveCatalog(catalog), ["regulatory-approvals", "patents"], {});
        expect(read).toEqual(["amass", "amass"]);
    });

    it("reads the credential that the settings name for a slot", async () => {
        const read: string[] = [];
        const base = createInMemoryCatalog({ connectors: [{ id: "pubmed", enabled: true, credentials: { ncbi: "ncbi-lab" } }] });
        const catalog = {
            ...base,
            credential: (name: string) => {
                read.push(name);
                return base.credential(name);
            },
        };
        await buildConnectorTools(catalog, await resolveCatalog(catalog), ["pubmed"], {});
        expect(read).toEqual(["ncbi-lab"]);
    });

    it("gives no web search without an engine or an endpoint", async () => {
        const catalog = createInMemoryCatalog();
        expect(await buildConnectorTools(catalog, await resolveCatalog(catalog), ["web-search"], {})).toEqual([]);
        const pointed = createInMemoryCatalog({ connectors: [{ id: "web-search", enabled: true, endpoint: "http://127.0.0.1:28437" }] });
        const tools = await buildConnectorTools(pointed, await resolveCatalog(pointed), ["web-search"], {});
        expect(tools.map((tool) => tool.id)).toEqual(["web_search"]);
    });
});
