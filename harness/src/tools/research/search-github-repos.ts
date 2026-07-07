/**
 * Search GitHub for code repositories. Used by the analogical-reasoner to
 * find implementations of cross-domain methods. Works unauthenticated
 * (lower rate limit); `GITHUB_TOKEN` raises the limit.
 *
 * Same wire call and envelope as the legacy tool. Stateless HTTP; no deps.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { apiFetchValidated, describeApiError } from "../lib/api-utils.js";

const BASE_URL = "https://api.github.com/search/repositories";

type SearchGithubReposOutput = { success: false; error: string; repos: GithubRepo[] } | { success: true; repos: GithubRepo[] };

export interface GithubRepo {
    url: string;
    fullName: string;
    description?: string;
    stars: number;
    language?: string;
    lastUpdated?: string;
}

// Raw GitHub search wire shape, validated at the fetch boundary. Every field is
// optional — `parseGithubReposResponse` already filters out items missing the
// fields it needs, so an over-strict schema would drop otherwise-usable pages.
const GithubReposResponseSchema = z.object({
    items: z
        .array(
            z.object({
                html_url: z.string().optional(),
                full_name: z.string().optional(),
                description: z.string().optional(),
                stargazers_count: z.number().optional(),
                language: z.string().optional(),
                updated_at: z.string().optional(),
            }),
        )
        .optional(),
});

export function parseGithubReposResponse(raw: unknown): GithubRepo[] {
    const items = (raw as { items?: unknown[] } | undefined)?.items;
    if (!Array.isArray(items)) return [];
    return items
        .filter(
            (i): i is Record<string, unknown> =>
                typeof i === "object" &&
                i !== null &&
                typeof (i as { html_url?: unknown }).html_url === "string" &&
                typeof (i as { full_name?: unknown }).full_name === "string",
        )
        .map((i) => ({
            url: String(i.html_url),
            fullName: String(i.full_name),
            description: typeof i.description === "string" ? i.description : undefined,
            stars: typeof i.stargazers_count === "number" ? i.stargazers_count : 0,
            language: typeof i.language === "string" ? i.language : undefined,
            lastUpdated: typeof i.updated_at === "string" ? i.updated_at : undefined,
        }));
}

export function createSearchGithubReposTool(deps: { githubToken?: string }) {
    return defineTool({
        id: "search_github_repos",
        description:
            "Search GitHub for code repositories matching a free-text query, " +
            "optionally filtered by programming language. Returns URL, full " +
            "name (owner/repo), description, star count, primary language, " +
            "and last-updated timestamp. Use to find implementations of " +
            "cross-domain methods cited in analogical-reasoning results.",
        inputSchema: z.object({
            query: z
                .string()
                .describe("GitHub search syntax. Plain text matches anywhere; qualifiers " + 'like "topic:bioinformatics" or "stars:>100" are supported.'),
            language: z.string().optional().describe('Optional language filter (e.g., "python").'),
            limit: z.number().int().min(1).max(20).default(10).describe("Maximum results (1–20, default 10)."),
        }),
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
