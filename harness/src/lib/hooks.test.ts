import { describe, expect, it } from "bun:test";
import { ResultAsync, errAsync, okAsync } from "neverthrow";

import { createCapturingLogger } from "../__tests__/setup/logger.js";
import { deliverNotice, passGate, type GateFailure, type NoticeFailure } from "./hooks.js";

describe("passGate", () => {
    it("gives the value of a gate that succeeds, as the host gives it", async () => {
        const result = await passGate("resolveSandboxLabels", okAsync<Record<string, string>, GateFailure>({ "example.com/tenant": "acme" }));
        expect(result._unsafeUnwrap()).toEqual({ "example.com/tenant": "acme" });
    });

    it("turns a gate err into a failed refusal that carries the reason of the host", async () => {
        const refusal = (await passGate("RunCharge.open", errAsync<void, GateFailure>({ reason: "r", suspend: false })))._unsafeUnwrapErr();
        expect(refusal).toEqual({ kind: "failed", gate: "RunCharge.open", reason: "r" });
    });

    it("turns a gate err with suspend into a suspended refusal, not a failed one", async () => {
        const refusal = (await passGate("RunAuthorizer.authorize", errAsync<void, GateFailure>({ reason: "r", suspend: true })))._unsafeUnwrapErr();
        expect(refusal).toEqual({ kind: "suspended", gate: "RunAuthorizer.authorize", reason: "r" });
    });

    it("does not catch a gate whose promise rejects", async () => {
        await expect(
            passGate("RunCharge.open", new ResultAsync<void, GateFailure>(Promise.reject(new Error("host defect")))).match(
                () => "ok",
                () => "err",
            ),
        ).rejects.toThrow("host defect");
    });
});

describe("deliverNotice", () => {
    it("resolves true for a notice that succeeds, and logs nothing", async () => {
        const log = createCapturingLogger();
        expect(await deliverNotice(log, "RunCharge.close", okAsync<void, NoticeFailure>(undefined))).toBe(true);
        expect(log.records).toEqual([]);
    });

    it("logs the reason of a notice err at the error level, and the outcome stays a success", async () => {
        const log = createCapturingLogger();
        const delivered = await deliverNotice(log, "RunAuthorizer.revoke", errAsync<void, NoticeFailure>({ reason: "r" }));
        expect(delivered).toBe(false);
        expect(log.records).toEqual([{ level: "error", msg: "a notice of the host failed", fields: { notice: "RunAuthorizer.revoke", reason: "r" } }]);
    });

    it("does not catch a notice whose promise rejects", async () => {
        await expect(
            deliverNotice(createCapturingLogger(), "UsageRecorder.record", new ResultAsync<void, NoticeFailure>(Promise.reject(new Error("host defect")))),
        ).rejects.toThrow("host defect");
    });
});
