import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUIDv7 } from "bun";

import { createCredentialSource } from "./credential.ts";

// The refreshing direct-mode credential source: env + command kinds, cache/refresh, and the two output
// formats. The command kinds spawn a real `/bin/sh` (deterministic counter / JSON commands) so the
// spawn+parse boundary is exercised end-to-end. This file drives process.env directly (eslint ignore) to
// exercise the `env`-kind source, which reads the live environment through env.ts's seam.
describe("createCredentialSource", () => {
    const scratch: string[] = [];
    /** A file-backed counter command whose stdout increments ("1", "2", …) on every invocation — proves cached vs re-run. */
    function counterCommand(): string {
        const file = join(tmpdir(), `cred-counter-${randomUUIDv7()}`);
        scratch.push(file);
        return `printf x >> '${file}'; wc -c < '${file}' | tr -d ' \\n'`;
    }
    /** A counter command that emits ExecCredential JSON with the given expiry, so the token also increments per run. */
    function execCredCommand(expiry: string): string {
        const file = join(tmpdir(), `cred-exec-${randomUUIDv7()}`);
        scratch.push(file);
        return `printf x >> '${file}'; n=$(wc -c < '${file}' | tr -d ' \\n'); printf '{"apiVersion":"client.authentication.k8s.io/v1","status":{"token":"tok-%s","expirationTimestamp":"%s"}}' "$n" "${expiry}"`;
    }

    afterEach(() => {
        for (const f of scratch.splice(0)) rmSync(f, { force: true });
        delete process.env.CRED_TEST_TOKEN;
    });

    test("env kind reads the named variable and yields the configured scheme, no expiry", async () => {
        process.env.CRED_TEST_TOKEN = "env-tok";
        const cred = (await createCredentialSource({ kind: "env", var: "CRED_TEST_TOKEN", scheme: "bearer" }).get())._unsafeUnwrap();
        expect(cred).toEqual({ token: "env-tok", scheme: "bearer" });
    });

    test("env kind errors when the variable is unset", async () => {
        const result = await createCredentialSource({ kind: "env", var: "CRED_TEST_TOKEN", scheme: "bearer" }).get();
        expect(result._unsafeUnwrapErr()).toEqual({ type: "env_var_unset", var: "CRED_TEST_TOKEN" });
    });

    test("env kind caches until forceRefresh re-reads the live variable", async () => {
        process.env.CRED_TEST_TOKEN = "v1";
        const source = createCredentialSource({ kind: "env", var: "CRED_TEST_TOKEN", scheme: "x-api-key" });
        expect((await source.get())._unsafeUnwrap().token).toBe("v1");
        process.env.CRED_TEST_TOKEN = "v2";
        // No expiry ⇒ get() keeps serving the cached value; only forceRefresh re-reads.
        expect((await source.get())._unsafeUnwrap().token).toBe("v1");
        expect((await source.forceRefresh())._unsafeUnwrap().token).toBe("v2");
        expect((await source.get())._unsafeUnwrap().token).toBe("v2");
    });

    test("command raw token is minted once, cached across get()s, and re-minted on forceRefresh", async () => {
        // ttlMs 60s > the 30s refresh buffer, so the token stays cached across get()s within the test.
        const source = createCredentialSource({ kind: "command", command: counterCommand(), scheme: "bearer", ttlMs: 60_000 });
        const first = (await source.get())._unsafeUnwrap();
        expect(first.token).toBe("1");
        expect(first.scheme).toBe("bearer");
        expect(first.expiresAt).toBeGreaterThan(Date.now());
        // Cached: the command does not re-run per request.
        expect((await source.get())._unsafeUnwrap().token).toBe("1");
        // forceRefresh (the 401 path) re-runs the command.
        expect((await source.forceRefresh())._unsafeUnwrap().token).toBe("2");
    });

    test("command raw token with empty output errors", async () => {
        const result = await createCredentialSource({ kind: "command", command: "true", scheme: "x-api-key" }).get();
        expect(result._unsafeUnwrapErr().type).toBe("command_empty_output");
    });

    test("a non-zero command exit surfaces as an actionable error, never a throw", async () => {
        const result = await createCredentialSource({ kind: "command", command: "echo boom >&2; exit 3", scheme: "bearer" }).get();
        const e = result._unsafeUnwrapErr();
        expect(e.type).toBe("command_exit_nonzero");
        if (e.type === "command_exit_nonzero") expect(e.exitCode).toBe(3);
    });

    test("exec-credential format parses status.token + expirationTimestamp and caches until near expiry", async () => {
        const future = new Date(Date.now() + 3_600_000).toISOString();
        const source = createCredentialSource({ kind: "command", command: execCredCommand(future), scheme: "bearer", format: "exec-credential" });
        const cred = (await source.get())._unsafeUnwrap();
        expect(cred.token).toBe("tok-1");
        expect(cred.expiresAt).toBe(Date.parse(future));
        // Far-future expiry ⇒ cached across get()s.
        expect((await source.get())._unsafeUnwrap().token).toBe("tok-1");
    });

    test("exec-credential expiry drives refresh: a past expiry re-runs the command on the next get()", async () => {
        const past = new Date(Date.now() - 60_000).toISOString();
        const source = createCredentialSource({ kind: "command", command: execCredCommand(past), scheme: "bearer", format: "exec-credential" });
        expect((await source.get())._unsafeUnwrap().token).toBe("tok-1");
        // Already past expiry (minus buffer) ⇒ the next get() re-mints rather than serving a stale token.
        expect((await source.get())._unsafeUnwrap().token).toBe("tok-2");
    });

    /** A command printing a raw JWT (unsigned; only the payload shape matters) with the given claim set. */
    function jwtCommand(claims: Record<string, unknown>): string {
        const jwt = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
        return `printf '%s' '${jwt}'`;
    }

    test("a raw JWT ages off its own exp claim instead of the default TTL", async () => {
        const exp = Math.floor(Date.now() / 1000) + 90; // 90s out — far inside the 5-min default window
        const source = createCredentialSource({ kind: "command", command: jwtCommand({ exp }), scheme: "bearer" });
        const cred = (await source.get())._unsafeUnwrap();
        expect(cred.expiresAt).toBe(exp * 1000);
    });

    test("the earliest of exp and ttlMs wins in both directions", async () => {
        const farExp = Math.floor(Date.now() / 1000) + 3_600;
        const capped = (
            await createCredentialSource({ kind: "command", command: jwtCommand({ exp: farExp }), scheme: "bearer", ttlMs: 60_000 }).get()
        )._unsafeUnwrap();
        // ttlMs (60s) is nearer than exp (1h): the cadence bound applies.
        expect(capped.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
        const nearExp = Math.floor(Date.now() / 1000) + 60;
        const floor = (
            await createCredentialSource({ kind: "command", command: jwtCommand({ exp: nearExp }), scheme: "bearer", ttlMs: 3_600_000 }).get()
        )._unsafeUnwrap();
        // exp (60s) is nearer than ttlMs (1h): the hard fact wins — ttlMs can never extend a hold past exp.
        expect(floor.expiresAt).toBe(nearExp * 1000);
    });

    test("a JWT-shaped token without a readable exp falls back to the default TTL", async () => {
        // Undecodable payload segment (not base64url JSON) — degrades to opaque-raw semantics, no error.
        const source = createCredentialSource({ kind: "command", command: `printf 'eyJhbGciOiJub25lIn0.!!!not-json!!!.sig'`, scheme: "bearer" });
        const cred = (await source.get())._unsafeUnwrap();
        expect(cred.expiresAt).toBeGreaterThan(Date.now());
        const noExp = (await createCredentialSource({ kind: "command", command: jwtCommand({ sub: "user" }), scheme: "bearer" }).get())._unsafeUnwrap();
        expect(noExp.expiresAt).toBeGreaterThan(Date.now());
    });

    test("a past exp still yields the credential, and the next get() re-mints", async () => {
        const file = join(tmpdir(), `cred-jwt-${randomUUIDv7()}`);
        scratch.push(file);
        // Counter-suffixed sub claim proves re-mint; exp is 60s in the PAST on every mint.
        const exp = Math.floor(Date.now() / 1000) - 60;
        const header = Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url");
        const command = `printf x >> '${file}'; n=$(wc -c < '${file}' | tr -d ' \\n'); p=$(printf '{"exp":${exp},"n":%s}' "$n" | base64 | tr '+/' '-_' | tr -d '=\\n'); printf '%s.%s.sig' '${header}' "$p"`;
        const source = createCredentialSource({ kind: "command", command, scheme: "bearer" });
        const first = (await source.get())._unsafeUnwrap();
        expect(first.expiresAt).toBe(exp * 1000); // expired at mint — returned anyway, marked expired
        const second = (await source.get())._unsafeUnwrap();
        expect(second.token).not.toBe(first.token); // aged out immediately ⇒ per-request re-mint, never a stale hold
    });

    test("exec-credential format rejects non-ExecCredential JSON with an actionable error", async () => {
        const result = await createCredentialSource({
            kind: "command",
            command: `printf '{"hello":"world"}'`,
            scheme: "bearer",
            format: "exec-credential",
        }).get();
        expect(result._unsafeUnwrapErr().type).toBe("exec_credential_invalid");
    });
});
