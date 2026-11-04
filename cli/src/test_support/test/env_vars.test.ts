import { describe, expect, test } from "bun:test";

import { clearEnvVars, unsetEnvVar, type EnvVars } from "../env_vars.ts";

describe("unsetEnvVar", () => {
    test("removes the key from a plain object", () => {
        const env: EnvVars = { A: "1", B: "2" };
        unsetEnvVar(env, "A");
        expect("A" in env).toBe(false);
        expect(env.B).toBe("2");
    });

    test("leaves an absent key absent", () => {
        const env: EnvVars = {};
        unsetEnvVar(env, "A");
        expect(Object.keys(env)).toEqual([]);
    });

    test("unsets a variable of the real environment, where an assignment of undefined would store the text", () => {
        const name = "INFLEXA_TEST_ENV_VARS_UNSET";
        Bun.env[name] = "set";
        unsetEnvVar(Bun.env, name);
        expect(Bun.env[name]).toBeUndefined();
        expect(name in Bun.env).toBe(false);
    });
});

describe("clearEnvVars", () => {
    test("clears the named variables and keeps the others", () => {
        const env: EnvVars = { A: "1", B: "2", C: "3" };
        clearEnvVars(env, ["A", "B"]);
        expect(env).toEqual({ C: "3" });
    });

    test("the restore puts each saved value back and unsets the variable that was absent", () => {
        const env: EnvVars = { A: "1" };
        const restore = clearEnvVars(env, ["A", "B"]);
        env.A = "changed";
        env.B = "added";
        restore();
        expect(env.A).toBe("1");
        expect("B" in env).toBe(false);
    });

    test("an empty string is a value and comes back as an empty string", () => {
        const env: EnvVars = { A: "" };
        const restore = clearEnvVars(env, ["A"]);
        expect("A" in env).toBe(false);
        restore();
        expect(env.A).toBe("");
    });

    test("works on the real environment and restores the text", () => {
        const name = "INFLEXA_TEST_ENV_VARS_CLEAR";
        Bun.env[name] = "kept";
        const restore = clearEnvVars(Bun.env, [name]);
        expect(Bun.env[name]).toBeUndefined();
        restore();
        expect(Bun.env[name]).toBe("kept");
        unsetEnvVar(Bun.env, name);
    });
});
