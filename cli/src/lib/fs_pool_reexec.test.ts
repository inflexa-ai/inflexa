import { describe, expect, test } from "bun:test";

import { SERVE_DETACHED_CHILD_FLAG } from "./child_flags.ts";
import { fsPoolVar } from "./env.ts";
import { ensureServerFsPool, type Execve } from "./fs_pool_reexec.ts";
import { selfInvocation } from "./self_invocation.ts";

type Call = { file: string; args: readonly string[]; env: Record<string, string | undefined> };

function spy(): { execve: Execve; calls: Call[] } {
    const calls: Call[] = [];
    return { execve: (file, args, env) => void calls.push({ file, args, env }), calls };
}

describe("ensureServerFsPool", () => {
    test("the foreground `serve` runs itself again with the pool of the server", () => {
        const { execve, calls } = spy();
        expect(ensureServerFsPool(["serve"], execve, { PATH: "/bin" }, "darwin")._unsafeUnwrap()).toBe("replaced");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.file).toBe(process.execPath);
        expect(calls[0]?.args).toEqual(selfInvocation(["serve"]));
        expect(calls[0]?.env.PATH).toBe("/bin");
        expect(Number(calls[0]?.env[fsPoolVar])).toBeGreaterThanOrEqual(64);
    });

    test("a root option with a value before `serve` is not the command word", () => {
        const { execve, calls } = spy();
        ensureServerFsPool(["--analysis", "x", "serve"], execve, {}, "linux")._unsafeUnwrap();
        ensureServerFsPool(["--project", "serve", "ls"], execve, {}, "linux")._unsafeUnwrap();
        expect(calls.map((call) => call.args)).toEqual([selfInvocation(["--analysis", "x", "serve"])]);
    });

    test("does nothing for the detached parent, the detached child, another command, a set variable, or Windows", () => {
        const { execve, calls } = spy();
        const outcomes = [
            ensureServerFsPool(["serve", "--detach"], execve, {}, "darwin")._unsafeUnwrap(),
            ensureServerFsPool(["serve", SERVE_DETACHED_CHILD_FLAG], execve, {}, "darwin")._unsafeUnwrap(),
            ensureServerFsPool(["ls"], execve, {}, "darwin")._unsafeUnwrap(),
            ensureServerFsPool([], execve, {}, "darwin")._unsafeUnwrap(),
            ensureServerFsPool(["serve"], execve, { [fsPoolVar]: "8" }, "darwin")._unsafeUnwrap(),
            ensureServerFsPool(["serve"], execve, {}, "win32")._unsafeUnwrap(),
            ensureServerFsPool(["serve"], undefined, {}, "darwin")._unsafeUnwrap(),
        ];
        expect(new Set(outcomes)).toEqual(new Set(["not_needed"]));
        expect(calls).toHaveLength(0);
    });

    test("a failed replacement is an error, and the process goes on", () => {
        const cause = new Error("ENOENT");
        const error = ensureServerFsPool(
            ["serve"],
            () => {
                throw cause;
            },
            {},
            "darwin",
        )._unsafeUnwrapErr();
        expect(error).toEqual({ type: "execve_failed", cause });
    });
});
