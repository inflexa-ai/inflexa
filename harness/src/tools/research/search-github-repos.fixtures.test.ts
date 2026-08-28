/**
 * The golden-fixture assertions of the GitHub repository-search contract.
 *
 * GitHub sends an explicit null for an absent `description` and an absent
 * `language`, and it never omits either key. The positive fixture carries all
 * four combinations of the two nulls, and the twin breaks the type of
 * `description`.
 *
 * The client keeps its schema private, thus the table drives the tool. That path
 * is the only in-repo reach to the schema, and it proves the map as well: the
 * tool reports a rejected payload as `success: false`, and a parsed payload as
 * the mapped repository rows.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { readFixture } from "../lib/__fixtures__/fixture-runner.js";
import { createSearchGithubReposTool, type GithubRepo } from "./search-github-repos.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

type SearchOutput = { success: false; error: string; repos: GithubRepo[] } | { success: true; repos: GithubRepo[] };

/** Run the tool over one fixture file, served as the whole HTTP answer. */
async function searchOver(file: string): Promise<SearchOutput> {
    const body = JSON.stringify(readFixture("github", file));
    globalThis.fetch = (async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const { ctx } = makeToolContext();
    const result = await createSearchGithubReposTool({}).execute({ query: "created:>2026-08-25", limit: 10 }, ctx);
    return result._unsafeUnwrap() as SearchOutput;
}

describe("GithubReposResponseSchema", () => {
    it("accepts the positive fixture", async () => {
        const output = await searchOver("01-new-repos-nodesc.json");

        expect(output.success).toBe(true);
        expect(output.repos).toHaveLength(4);
    });

    it("maps the positive fixture to the expected output", async () => {
        const { repos } = await searchOver("01-new-repos-nodesc.json");
        const [bothNull, noDescription, noLanguage, complete] = repos;

        // A null description and a null language become an absent field, thus the
        // row still reaches the caller with its url, name, and star count.
        expect(bothNull).toEqual({
            url: "https://github.com/xun1985/fvdvuq",
            fullName: "xun1985/fvdvuq",
            description: undefined,
            stars: 0,
            language: undefined,
            lastUpdated: "2026-08-28T09:36:40Z",
        });
        expect(noDescription?.language).toBe("Go");
        expect(noDescription?.description).toBeUndefined();
        expect(noLanguage?.language).toBeUndefined();
        expect(noLanguage?.description).toContain("Career guidance");
        expect(complete).toMatchObject({ language: "Jupyter Notebook", fullName: "luigisantorodev/network-intrusion-anomaly-detection" });
    });

    it("maps a zero-result answer to an empty list", async () => {
        const output = await searchOver("05-zero-results.json");

        expect(output).toEqual({ success: true, repos: [] });
    });

    it("rejects the drift twin", async () => {
        const output = await searchOver("01-new-repos-nodesc.drift.json");

        expect(output.success).toBe(false);
        expect(output.success === false ? output.error : "").toContain("did not match the expected schema");
    });
});
