import { describe, expect, it } from "bun:test";

import { describeFsError, isAbsent, tryFetch, tryFs, tryFsWrite, type FsError } from "./fs-result.js";

/** A synthetic `fs`/system throw carrying an errno `code`. */
function errnoThrow(code: string): Error & { code: string } {
    return Object.assign(new Error(code), { code });
}

describe("fs-result", () => {
    describe("isAbsent", () => {
        it("is true for ENOENT and ENOTDIR", () => {
            expect(isAbsent(errnoThrow("ENOENT"))).toBe(true);
            expect(isAbsent(errnoThrow("ENOTDIR"))).toBe(true);
        });

        it("is false for permission / EISDIR / non-errno throws", () => {
            expect(isAbsent(errnoThrow("EACCES"))).toBe(false);
            expect(isAbsent(errnoThrow("EISDIR"))).toBe(false);
            expect(isAbsent(new Error("boom"))).toBe(false);
            expect(isAbsent("not-an-error")).toBe(false);
            expect(isAbsent(undefined)).toBe(false);
        });
    });

    describe("tryFs", () => {
        it("returns ok with the mapped value on a successful read", async () => {
            const result = await tryFs("ws.readFile", async () => "contents");
            expect(result.isOk()).toBe(true);
            expect(result._unsafeUnwrap()).toBe("contents");
        });

        it("absence with onAbsent stays in the ok channel as the sentinel, never err", async () => {
            const result = await tryFs<string | null>(
                "ws.readFile",
                async () => {
                    throw errnoThrow("ENOENT");
                },
                { path: "/missing.txt", onAbsent: () => null },
            );
            expect(result.isOk()).toBe(true);
            expect(result._unsafeUnwrap()).toBeNull();
        });

        it("ENOTDIR with onAbsent also routes to the sentinel", async () => {
            const result = await tryFs<string[]>(
                "ws.listFiles",
                async () => {
                    throw errnoThrow("ENOTDIR");
                },
                { onAbsent: () => [] },
            );
            expect(result.isOk()).toBe(true);
            expect(result._unsafeUnwrap()).toEqual([]);
        });

        it("absence WITHOUT onAbsent falls through as err(read_failed)", async () => {
            const result = await tryFs("ws.readFile", async () => {
                throw errnoThrow("ENOENT");
            });
            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
                expect(result.error.type).toBe("read_failed");
            }
        });

        it("maps EACCES to err(permission_denied) carrying op + path + cause", async () => {
            const cause = errnoThrow("EACCES");
            const result = await tryFs(
                "ws.readFile",
                async () => {
                    throw cause;
                },
                { path: "/locked.txt", onAbsent: () => null },
            );
            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
                const e = result.error;
                expect(e.type).toBe("permission_denied");
                expect(e.op).toBe("ws.readFile");
                expect(e.path).toBe("/locked.txt");
                expect(e.cause).toBe(cause);
            }
        });

        it("maps EPERM to err(permission_denied)", async () => {
            const result = await tryFs("ws.readFile", async () => {
                throw errnoThrow("EPERM");
            });
            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
                expect(result.error.type).toBe("permission_denied");
            }
        });

        it("maps EISDIR to err(is_a_directory)", async () => {
            const result = await tryFs("ws.readFile", async () => {
                throw errnoThrow("EISDIR");
            });
            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
                expect(result.error.type).toBe("is_a_directory");
            }
        });

        it("maps an unclassified throw (EMFILE) to err(read_failed)", async () => {
            const result = await tryFs("ws.readFile", async () => {
                throw errnoThrow("EMFILE");
            });
            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
                const e = result.error;
                expect(e.type).toBe("read_failed");
                expect(e.op).toBe("ws.readFile");
            }
        });
    });

    describe("tryFsWrite", () => {
        it("returns ok on a successful write", async () => {
            const result = await tryFsWrite("ws.writeFile", async () => 42);
            expect(result.isOk()).toBe(true);
            expect(result._unsafeUnwrap()).toBe(42);
        });

        it("maps EACCES to err(permission_denied)", async () => {
            const result = await tryFsWrite("ws.writeFile", async () => {
                throw errnoThrow("EACCES");
            });
            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
                expect(result.error.type).toBe("permission_denied");
            }
        });

        it("maps an unclassified throw (ENOSPC) to err(write_failed)", async () => {
            const result = await tryFsWrite(
                "ws.writeFile",
                async () => {
                    throw errnoThrow("ENOSPC");
                },
                { path: "/full" },
            );
            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
                const e = result.error;
                expect(e.type).toBe("write_failed");
                expect(e.path).toBe("/full");
            }
        });

        it("absence with onAbsent stays in the ok channel", async () => {
            const result = await tryFsWrite<number>(
                "ws.mkdir",
                async () => {
                    throw errnoThrow("ENOENT");
                },
                { onAbsent: () => 0 },
            );
            expect(result.isOk()).toBe(true);
            expect(result._unsafeUnwrap()).toBe(0);
        });
    });

    describe("tryFetch", () => {
        it("a null return (file not present remotely) stays in the ok channel", async () => {
            const result = await tryFetch("presigned.fetch", async () => null);
            expect(result.isOk()).toBe(true);
            expect(result._unsafeUnwrap()).toBeNull();
        });

        it("a throw becomes err(fetch_failed) carrying op + path + cause", async () => {
            const cause = new Error("network down");
            const result = await tryFetch(
                "presigned.fetch",
                async () => {
                    throw cause;
                },
                "/remote/file",
            );
            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
                const e = result.error;
                expect(e.type).toBe("fetch_failed");
                expect(e.op).toBe("presigned.fetch");
                expect(e.path).toBe("/remote/file");
                expect(e.cause).toBe(cause);
            }
        });
    });

    describe("describeFsError", () => {
        it("renders each variant to a one-line description, with the path when present", () => {
            const cases: Array<[FsError, string]> = [
                [{ type: "read_failed", op: "r", path: "/a", cause: 1 }, "filesystem read failed (r: /a)"],
                [{ type: "write_failed", op: "w", cause: 1 }, "filesystem write failed (w)"],
                [{ type: "permission_denied", op: "p", path: "/b", cause: 1 }, "filesystem permission denied (p: /b)"],
                [{ type: "is_a_directory", op: "d", path: "/c", cause: 1 }, "expected a file but found a directory (d: /c)"],
                [{ type: "fetch_failed", op: "f", cause: 1 }, "remote file fetch failed (f)"],
            ];
            for (const [e, expected] of cases) {
                expect(describeFsError(e)).toBe(expected);
            }
        });
    });
});
