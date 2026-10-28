/**
 * Search GitHub for code repositories. Used by the analogical-reasoner to
 * find implementations of cross-domain methods. Works unauthenticated
 * (lower rate limit); `GITHUB_TOKEN` raises the limit.
 *
 * Same wire call and envelope as the legacy tool. Stateless HTTP; no deps.
 *
 * Absence policy: the OpenAPI document of GitHub marks `description` and
 * `language` as required and nullable, thus an absent value is an explicit
 * `null`. The OpenAPI document gives the modifier of each field.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type Tool, type ToolError } from "../define-tool.js";
import { apiFetchValidated, describeApiError } from "../lib/api-utils.js";
import { parseUnknownRecord } from "../../lib/unknown-containers.js";
import { isUnknownArray } from "../../lib/unknown-array.js";

const BASE_URL = "https://api.github.com/search/repositories";

const SearchGithubReposOutputSchema = z.object({
    success: z.boolean(),
    error: z.string().optional().describe("Present when success is false: why the search failed."),
    repos: z.array(
        z.object({
            url: z.string(),
            fullName: z.string(),
            description: z.string().optional(),
            stars: z.number(),
            language: z.string().optional(),
            lastUpdated: z.string().optional(),
        }),
    ),
});

type SearchGithubReposOutput = { success: false; error: string; repos: GithubRepo[] } | { success: true; repos: GithubRepo[] };

export type GithubRepo = {
    url: string;
    fullName: string;
    description?: string;
    stars: number;
    language?: string;
    lastUpdated?: string;
};

// Raw GitHub search wire shape, validated at the fetch boundary. Every field is
// optional — `parseGithubReposResponse` already filters out items missing the
// fields it needs, so an over-strict schema would drop otherwise-usable pages.
// `description` and `language` are also `.nullable()` because GitHub sends an
// explicit JSON `null` (not omission) for repos lacking them — the common case,
// which a bare `.optional()` would reject and take the whole page down with it.
const GithubReposResponseSchema = z.object({
    items: z
        .array(
            z.object({
                html_url: z.string().optional(),
                full_name: z.string().optional(),
                description: z.string().nullable().optional(),
                stargazers_count: z.number().optional(),
                language: z.string().nullable().optional(),
                updated_at: z.string().optional(),
            }),
        )
        .optional(),
});

export function parseGithubReposResponse(raw: unknown): GithubRepo[] {
    const items = parseUnknownRecord(raw)?.items;
    if (!isUnknownArray(items)) return [];
    return items.flatMap((item) => {
        const record = parseUnknownRecord(item);
        if (record === undefined || typeof record.html_url !== "string" || typeof record.full_name !== "string") return [];
        return [
            {
                url: record.html_url,
                fullName: record.full_name,
                description: typeof record.description === "string" ? record.description : undefined,
                stars: typeof record.stargazers_count === "number" ? record.stargazers_count : 0,
                language: typeof record.language === "string" ? record.language : undefined,
                lastUpdated: typeof record.updated_at === "string" ? record.updated_at : undefined,
            },
        ];
    });
}

const SearchGithubReposInputSchema = z.object({
    query: z.string().describe("GitHub search syntax. Plain text matches anywhere; qualifiers " + 'like "topic:bioinformatics" or "stars:>100" are supported.'),
    language: z.string().optional().describe('Optional language filter (e.g., "python").'),
    limit: z.number().int().min(1).max(20).default(10).describe("Maximum results (1–20, default 10)."),
});

export function createSearchGithubReposTool(deps: { githubToken?: string }): Tool<z.infer<typeof SearchGithubReposInputSchema>, SearchGithubReposOutput> {
    return defineTool({
        id: "search_github_repos",
        description:
            "Search GitHub for code repositories matching a free-text query, " +
            "optionally filtered by programming language. Results are sorted by " +
            "star count, highest first, not by relevance. Returns URL, full " +
            "name (owner/repo), description, star count, primary language, " +
            "and last-updated timestamp; description and language are absent " +
            "when GitHub holds none. Use to find a published implementation of " +
            "a method or a pipeline.\n" +
            "ABSENCE IS NORMAL: an empty repos array means no repository matched, " +
            "and `success: false` with an `error` string means GitHub could not be " +
            "reached or refused the request (the low unauthenticated rate limit " +
            "lands here). Report either one and continue, do not retry unchanged.",
        outputSchema: SearchGithubReposOutputSchema,
        inputSchema: SearchGithubReposInputSchema,
        describeCall: "none",
        execute: async ({ query, language, limit }): Promise<Result<SearchGithubReposOutput, ToolError>> => {
            const q = language ? `${query} language:${language}` : query;
            const params = new URLSearchParams({
                q,
                per_page: String(limit),
                sort: "stars",
                order: "desc",
            });
            const headers: Record<string, string> = {
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            };
            if (deps.githubToken) {
                headers.Authorization = `Bearer ${deps.githubToken}`;
            }
            const res = await apiFetchValidated(`${BASE_URL}?${params}`, GithubReposResponseSchema, { headers });
            if (res.isErr()) {
                return ok({ success: false as const, error: describeApiError(res.error), repos: [] });
            }
            return ok({ success: true as const, repos: parseGithubReposResponse(res.value) });
        },
    });
}
