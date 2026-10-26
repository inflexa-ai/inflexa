import { describe, expect, test } from "bun:test";

import { friendlyStepLabel } from "./status.ts";

// Names as recorded in dbos.operation_outputs by the profile workflow — the
// progress channel parses them, so pin the observed formats.
describe("friendlyStepLabel", () => {
    test("model steps read as a model call", () => {
        expect(friendlyStepLabel("data-profiler.model")).toBe("model call");
    });

    test("tool steps keep the tool name and drop the call id", () => {
        expect(friendlyStepLabel("list_files.toolu_01GUZLfmSCFH2Jayq9Rhg5ua")).toBe("tool list_files");
        expect(friendlyStepLabel("execute_command.call_7Hx2")).toBe("tool execute_command");
    });

    test("a harness step with a dotted name is no tool step", () => {
        expect(friendlyStepLabel("sandbox.create")).toBe("sandbox.create");
    });

    test("exec dispatch and recv-loop steps read as sandbox activity", () => {
        expect(friendlyStepLabel("sandbox.submit-exec.dataprofile:an-1:n-1:profile:fn-3")).toBe("dispatching sandbox command");
        expect(friendlyStepLabel("DBOS.recv")).toBe("sandbox executing");
        expect(friendlyStepLabel("DBOS.sleep")).toBe("sandbox executing");
        expect(friendlyStepLabel("DBOS.now")).toBe("sandbox executing");
    });

    test("unknown step names pass through verbatim", () => {
        expect(friendlyStepLabel("DBOS.getResult")).toBe("DBOS.getResult");
    });
});
