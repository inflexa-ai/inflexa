import { describe, expect, test } from "bun:test";

import { generateApiKey, proxyConfig } from "./setup.ts";
import { env } from "../../lib/env.ts";

describe("generateApiKey", () => {
    test("returns an sk- prefixed key of 45 alphanumeric characters", () => {
        expect(generateApiKey()).toMatch(/^sk-[A-Za-z0-9]{45}$/);
    });

    test("returns a different key on each call", () => {
        expect(generateApiKey()).not.toBe(generateApiKey());
    });
});

describe("proxyConfig", () => {
    test("embeds the api key, the proxy port, and the container auth dir as YAML", () => {
        const yaml = proxyConfig("sk-test-key");
        expect(yaml).toContain('api-keys:\n  - "sk-test-key"');
        expect(yaml).toContain(`port: ${env.cliproxyPort}`);
        expect(yaml).toContain('auth-dir: "/root/.cli-proxy-api"');
        expect(yaml).toContain('host: ""');
    });
});
