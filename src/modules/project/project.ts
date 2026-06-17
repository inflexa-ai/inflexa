import { str256 } from "../../lib/types.ts";
import { createProject } from "../../db/primary_mutation.ts";
import { listProjects, countAnalysesByProject } from "../../db/primary_query.ts";

/** `inf project new <name>` — create a project, validating the name at this CLI boundary. */
export function projectNew(name: string, opts: { description?: string; tags?: string }): void {
    const validName = str256(name).match(
        (s) => s,
        (e) => {
            console.error(`Invalid project name: ${e === "empty" ? "must not be blank" : "must be at most 256 characters"}.`);
            process.exit(1);
        },
    );

    // Tags arrive as a single comma-separated flag value; split, trim, and drop blanks.
    const tags = opts.tags
        ? opts.tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
        : [];

    createProject({ name: validName, description: opts.description ?? null, tags }).match(
        (project) => console.log(`Created project "${project.name}" (${project.id})`),
        (error) => {
            if (error.type === "constraint_violation" && error.constraint === "unique") {
                console.error(`A project named "${name}" already exists.`);
            } else {
                console.error(`Failed to create project: ${error.type}`, error.cause);
            }
            process.exit(1);
        },
    );
}

/** `inf project ls` — list projects, each with its analysis count. */
export function projectLs(): void {
    listProjects().match(
        (projects) => {
            if (projects.length === 0) {
                console.log("No projects.");
                return;
            }

            console.log(`\n  Projects (${projects.length}):\n`);
            for (const p of projects) {
                const count = countAnalysesByProject(p.id).match(
                    (n) => n,
                    () => 0,
                );
                const tags = p.tags.length ? ` [${p.tags.join(", ")}]` : "";
                console.log(`  ${p.id}  ${p.name}${tags}  (${count} analyses)`);
            }
            console.log();
        },
        (error) => {
            console.error(`Failed to list projects: ${error.type}`, error.cause);
            process.exit(1);
        },
    );
}
