import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Bus } from "../../lib/bus.ts";
import { releaseInstanceLock } from "../../lib/lock.ts";
import { str256 } from "../../lib/types.ts";
import type { BusEvent } from "../../types/events.ts";
import { freshDb } from "../../test_support/db.ts";
import { listAnalysisInputs } from "../../db/primary_query.ts";
import { createAnalysis } from "./analysis.ts";
import { runInputsAdd, runInputsLs, runInputsRemove } from "./inputs_command.ts";

// The command actions resolve their analysis from process.cwd(), so each test runs cd'd into the
// analysis's anchor folder. console.log is captured to keep the test quiet and assert on output.
describe("inputs command actions", () => {
    let dir = "";
    let analysisId = "";
    let origCwd = "";
    let logs: string[] = [];
    const origLog = console.log;

    beforeEach(() => {
        freshDb();
        origCwd = process.cwd();
        dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-cmd-")));
        analysisId = createAnalysis({ cwd: dir, name: str256("cmd")._unsafeUnwrap() })._unsafeUnwrap().id;
        process.chdir(dir);
        logs = [];
        console.log = (...args: unknown[]): void => void logs.push(args.join(" "));
    });

    afterEach(() => {
        console.log = origLog;
        process.chdir(origCwd);
        releaseInstanceLock(analysisId);
        rmSync(dir, { recursive: true, force: true });
    });

    test("add registers an existing file and emits prov.input_added", () => {
        writeFileSync(join(dir, "data.csv"), "x\n");
        const events: string[] = [];
        const handler = (e: BusEvent): void => void (e.type === "prov.input_added" && events.push(e.type));
        Bus.on("inflexa", handler);
        runInputsAdd({}, ["data.csv"]);
        Bus.off("inflexa", handler);

        expect(
            listAnalysisInputs(analysisId)
                ._unsafeUnwrap()
                .map((i) => i.path),
        ).toEqual(["data.csv"]);
        expect(events).toEqual(["prov.input_added"]);
        expect(logs.join("\n")).toContain("Added 1 input");
    });

    test("ls lists the current inputs", () => {
        writeFileSync(join(dir, "data.csv"), "x\n");
        runInputsAdd({}, ["data.csv"]);
        logs = [];
        runInputsLs({});
        expect(logs.join("\n")).toContain("data.csv");
    });

    test("remove drops a current input and reports a non-input as a no-op", () => {
        writeFileSync(join(dir, "data.csv"), "x\n");
        runInputsAdd({}, ["data.csv"]);
        logs = [];
        runInputsRemove({}, ["data.csv", "not-an-input.csv"]);

        expect(listAnalysisInputs(analysisId)._unsafeUnwrap()).toHaveLength(0);
        const out = logs.join("\n");
        expect(out).toContain("Removed");
        expect(out).toContain("Not current inputs (skipped): not-an-input.csv");
    });
});
