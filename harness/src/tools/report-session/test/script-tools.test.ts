import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { okAsync, type ResultAsync } from "neverthrow";

import type { DbError } from "../../../lib/db-result.js";
import { computeSha256 } from "../../../lib/fs-helpers.js";
import type { SessionProvenanceEvent } from "../../../provenance/seam.js";
import { makeSession } from "../../../providers/__fixtures__/session.js";
import type { ReportSnapshot } from "../../../report-model/reference-resolver.js";
import type { AppendDerivationOutcome, DerivationRecord } from "../../../state/report-session-state.js";
import { createWorkspaceFilesystem } from "../../../workspace/filesystem.js";
import { reportSessionDerivedDir } from "../../../workspace/paths.js";
import { makeToolContext } from "../../__fixtures__/tool-context.js";
import type { Tool, ToolContext } from "../../define-tool.js";
import type { ReportSessionStateGateway, SessionStateLoad } from "../../report-authoring/authoring-tools.js";
import { createRunScriptTool, type RunScriptOutput } from "../../script/run-script.js";
import { createReportScriptTools } from "../script-tools.js";

const ANALYSIS = "analysis-001";
const THREAD = "thread-r1";
const PINNED = "runs/r1/s1/output/de.csv";
const TABLE = "group,n\na,3\nb,5\na,2\n";

let root: string;
let records: DerivationRecord[];
let events: SessionProvenanceEvent[];
let snapshot: ReportSnapshot;

function gateway(): ReportSessionStateGateway {
    return {
        load(): Promise<SessionStateLoad> {
            const artifacts = { ...snapshot.artifacts };
            for (const record of records) artifacts[record.outputPath] = { hash: record.outputHash };
            return Promise.resolve({
                outcome: "found",
                state: { document: { title: "", sections: [] }, snapshot: { ...snapshot, artifacts } },
                analysisId: ANALYSIS,
                token: { title: "", sections: [] },
                seenDocumentHash: null,
                derivations: structuredClone(records),
            });
        },
        persist: () => Promise.resolve({ outcome: "persisted" }),
        stampRendered: () => Promise.resolve({ outcome: "stamped" }),
        stampSeen: () => Promise.resolve({ outcome: "stamped" }),
    };
}

function tools(): Tool[] {
    const resolveWorkspaceRoot = (): Promise<string> => Promise.resolve(root);
    return createReportScriptTools({
        gateway: gateway(),
        workspaceFs: createWorkspaceFilesystem({ resolveWorkspaceRoot }),
        resolveWorkspaceRoot,
        derivations: {
            appendDerivation(_threadId: string, record: DerivationRecord): ResultAsync<AppendDerivationOutcome, DbError> {
                if (records.some((held) => held.outputPath === record.outputPath)) return okAsync("duplicate");
                records.push(record);
                return okAsync("appended");
            },
        },
        provenance: { emitSessionEvent: (event) => events.push(event) },
    });
}

function ctx(invocationId = "toolu_1"): ToolContext {
    return { ...makeToolContext().ctx, invocationId, session: makeSession({ scope: { kind: "analysis", analysisId: ANALYSIS, threadId: THREAD } }) };
}

async function run(code: string, invocationId?: string): Promise<RunScriptOutput> {
    return (await createRunScriptTool(tools()).execute({ code }, ctx(invocationId)))._unsafeUnwrap();
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "report-scripts-"));
    mkdirSync(join(root, "runs/r1/s1/output"), { recursive: true });
    writeFileSync(join(root, PINNED), TABLE);
    snapshot = { artifacts: { [PINNED]: { hash: computeSha256(Buffer.from(TABLE)) } } };
    records = [];
    events = [];
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const derive = `
    const table = await tools.read_table({ path: "${PINNED}" });
    const sums = {};
    for (const row of table.rows) sums[row.group] = (sums[row.group] ?? 0) + row.n;
    const rows = Object.entries(sums).map(([group, n]) => ({ group, n }));
    return await tools.write_derived({ name: "by_group.csv", rows, inputs: ["${PINNED}"] });
`;

describe("the script tools of a report session", () => {
    test("a script derives a table with no container, pins it with its inputs and its code, and emits the derivation", async () => {
        const result = await run(derive);

        const outputPath = `${reportSessionDerivedDir(THREAD)}/by_group.csv`;
        expect(result).toMatchObject({ ok: true, value: { path: outputPath, columns: ["group", "n"] } });
        expect(readFileSync(join(root, outputPath), "utf8")).toBe("group,n\na,5\nb,5\n");
        expect(records).toMatchObject([
            {
                outputPath,
                sources: [{ path: PINNED, hash: computeSha256(Buffer.from(TABLE)) }],
                script: derive,
                scriptHash: computeSha256(Buffer.from(derive)),
                toolCallId: "toolu_1:2",
            },
        ]);
        expect(events).toMatchObject([{ type: "run-derivation", threadId: THREAD, outputPath }]);
    });

    test("a rerun of the call gives its record back, and lands no second record", async () => {
        await run(derive);
        const again = await run(derive);

        expect(again).toMatchObject({ ok: true, value: { path: `${reportSessionDerivedDir(THREAD)}/by_group.csv` } });
        expect(records).toHaveLength(1);
        expect(events).toHaveLength(2);
    });

    test("a name that the session holds is refused for a different call", async () => {
        await run(derive);

        const second = await run(derive, "toolu_2");

        expect(second.ok).toBe(false);
        expect(second.error).toContain("already holds");
    });

    test("read_table refuses a table that is not pinned, and a pinned table whose bytes changed", async () => {
        writeFileSync(join(root, "runs/r1/s1/output/other.csv"), "a\n1\n");
        const unpinned = await run(`return await tools.read_table({ path: "runs/r1/s1/output/other.csv" });`);
        writeFileSync(join(root, PINNED), "group,n\na,9\n");
        const changed = await run(`return await tools.read_table({ path: "${PINNED}" });`);

        expect(unpinned.error).toContain("holds no artifact at runs/r1/s1/output/other.csv");
        expect(changed.error).toContain("changed after the session pinned it");
    });

    test("write_derived refuses an input that is not pinned, and a call from outside a script", async () => {
        const input = await run(`return await tools.write_derived({ name: "x.csv", rows: [{ a: 1 }], inputs: ["runs/none.csv"] });`);
        const direct = await tools()[1]?.execute({ name: "x.csv", rows: [{ a: 1 }], inputs: [PINNED] }, ctx());

        expect(input.error).toContain("holds no artifact at runs/none.csv");
        expect(direct?._unsafeUnwrapErr().error).toBe("write_derived runs inside a script only");
    });
});
