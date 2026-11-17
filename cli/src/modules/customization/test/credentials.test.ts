import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";

import * as envModule from "../../../lib/env.ts";
import { createCredentialReader, resolveCredentialReferences, type CredentialReader, type CredentialReaderOpts } from "../credentials.ts";

// The `env` kind reads the live environment through `readEnvCredentialVar` of env.ts. The test replaces that one
// reader, thus no test writes to `process.env`.
const ENV_VALUES: Record<string, string> = { GITHUB_TOKEN: "gh-token", NCBI_KEY: "ncbi-key" };
let readVar: Mock<typeof envModule.readEnvCredentialVar>;

beforeEach(() => {
    readVar = spyOn(envModule, "readEnvCredentialVar").mockImplementation((name) => ENV_VALUES[name]);
});
afterEach(() => {
    readVar.mockRestore();
});

const NO_STORED: CredentialReaderOpts["stored"] = { read: () => Promise.resolve(undefined) };

function readerOver(declarations: () => Record<string, unknown> | undefined, stored: CredentialReaderOpts["stored"] = NO_STORED): CredentialReader {
    return createCredentialReader({ declarations, stored });
}

describe("createCredentialReader", () => {
    test("a `stored` credential gives the value of the store, and the config holds no value", async () => {
        const reader = readerOver(() => ({ "lims-key": { kind: "stored" } }), {
            read: (name) => Promise.resolve(name === "lims-key" ? "typed-key" : undefined),
        });

        expect(await reader.read("lims-key")).toBe("typed-key");
    });

    test("an `env` credential gives the value of its variable", async () => {
        const reader = readerOver(() => ({ github: { kind: "env", var: "GITHUB_TOKEN" } }));

        expect(await reader.read("github")).toBe("gh-token");
        expect(readVar).toHaveBeenCalledWith("GITHUB_TOKEN");
    });

    test("a `command` credential gives the output of its helper command", async () => {
        const reader = readerOver(() => ({ lims: { kind: "command", command: "printf helper-token" } }));

        expect(await reader.read("lims")).toBe("helper-token");
    });

    test("a name that the config does not declare gives undefined", async () => {
        const reader = readerOver(() => ({ github: { kind: "env", var: "GITHUB_TOKEN" } }));

        expect(await reader.read("ncbi")).toBeUndefined();
        expect(await readerOver(() => undefined).read("github")).toBeUndefined();
    });

    test("a declaration that does not parse gives undefined", async () => {
        const reader = readerOver(() => ({ github: { kind: "vault", path: "x" } }));

        expect(await reader.read("github")).toBeUndefined();
    });

    test("a variable that is not set gives undefined", async () => {
        const reader = readerOver(() => ({ github: { kind: "env", var: "UNSET_TOKEN" } }));

        expect(await reader.read("github")).toBeUndefined();
    });

    test("a change of the declaration builds a new source, thus the next read uses the new variable", async () => {
        let declarations: Record<string, unknown> = { key: { kind: "env", var: "GITHUB_TOKEN" } };
        const reader = readerOver(() => declarations);

        expect(await reader.read("key")).toBe("gh-token");
        declarations = { key: { kind: "env", var: "NCBI_KEY" } };
        expect(await reader.read("key")).toBe("ncbi-key");
    });
});

describe("resolveCredentialReferences", () => {
    const reader: CredentialReader = { read: (name) => Promise.resolve(name === "github" ? "gh-token" : undefined) };

    test("each reference becomes the value of its credential", async () => {
        expect(await resolveCredentialReferences("Bearer ${cred:github} and ${cred:github}", reader)).toBe("Bearer gh-token and gh-token");
    });

    test("a reference whose credential has no value becomes an empty string", async () => {
        expect(await resolveCredentialReferences("key=${cred:ncbi};", reader)).toBe("key=;");
    });

    test("text with no reference, or with a reference that does not close, stays as it is", async () => {
        expect(await resolveCredentialReferences("plain", reader)).toBe("plain");
        expect(await resolveCredentialReferences("Bearer ${cred:github", reader)).toBe("Bearer ${cred:github");
    });
});
