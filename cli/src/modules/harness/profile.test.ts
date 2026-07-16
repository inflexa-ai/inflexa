import { describe, expect, test } from "bun:test";

import { describeBootError, friendlyStepLabel } from "./profile.ts";

// Names as recorded in dbos.operation_outputs by the profile workflow — the
// progress channel parses them, so pin the observed formats.
describe("friendlyStepLabel", () => {
    test("llm steps become 1-based model rounds", () => {
        expect(friendlyStepLabel("llm-0")).toBe("model round 1");
        expect(friendlyStepLabel("llm-9")).toBe("model round 10");
    });

    test("tool steps keep the tool name and drop the call id", () => {
        expect(friendlyStepLabel("tool-list_files-toolu_01GUZLfmSCFH2Jayq9Rhg5ua")).toBe("tool list_files");
        expect(friendlyStepLabel("tool-execute_command-toolu_01D7mGXcJEDoyY9VyMPmzmih")).toBe("tool execute_command");
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

// The sandbox_engine_unresolved arm carries a message already built against the
// pinned runtime AND host platform at resolution time, so it must be surfaced
// verbatim rather than re-wrapped.
describe("describeBootError", () => {
    test("sandbox_engine_unresolved surfaces the resolution message verbatim", () => {
        const message =
            "Could not resolve the Podman sandbox-engine socket — the Podman machine is not running.\n  Start it with `podman machine start`, then re-run.";
        expect(describeBootError({ type: "sandbox_engine_unresolved", message })).toBe(message);
    });
});
