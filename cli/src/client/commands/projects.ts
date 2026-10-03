import { MAX_PER_PAGE } from "../../api/common.ts";
import type { ProjectSummary } from "../../api/projects.ts";
import { fail } from "../../lib/cli.ts";
import { describeClientError, DEFAULT_CLIENT_OPTS, type ClientOpts } from "../api.ts";
import { createProject, fetchProjects } from "../projects.ts";

/** `inflexa project new <name>`: make a project through the server. The server validates the name. */
export async function projectNew(name: string, flags: { description?: string; tags?: string }, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    // `--tags` is one comma-separated flag value. The server trims each tag and drops a blank one.
    const tags = flags.tags === undefined ? [] : flags.tags.split(",");
    (await createProject({ name, tags, ...(flags.description === undefined ? {} : { description: flags.description }) }, opts)).match(
        (project) => console.log(`Created project "${project.name}" (${project.id})`),
        (e) => fail(describeClientError(e)),
    );
}

/** `inflexa project ls`: list each project, with its analysis count. */
export async function projectLs(opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const projects: ProjectSummary[] = [];
    // One request for each page of the largest size: the list is bounded for each request, and the loop
    // ends at the first page with no more.
    for (let page = 0; ; page++) {
        const list = (await fetchProjects({ page, perPage: MAX_PER_PAGE }, opts)).match(
            (l) => l,
            (e) => fail(describeClientError(e)),
        );
        projects.push(...list.projects);
        if (!list.hasMore) break;
    }

    if (projects.length === 0) {
        console.log("No projects.");
        return;
    }
    console.log(`\n  Projects (${projects.length}):\n`);
    for (const p of projects) {
        const tags = p.tags.length ? ` [${p.tags.join(", ")}]` : "";
        console.log(`  ${p.id}  ${p.name}${tags}  (${p.analysisCount} analyses)`);
    }
    console.log();
}
