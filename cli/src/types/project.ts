import type { ID, Str256 } from "@/lib/types";

export type ProjectId = ID;

/**
 * An optional, metadata-only grouping of analyses — the local mirror of the platform's
 * `study.projects`, minus org/billing scoping. It is **never** a storage location and is
 * never required: an analysis can exist without one, and every flow must work with zero
 * projects. Grouping is the whole feature; an analysis points at a project via its
 * `projectId`, not the reverse.
 */
export type Project = {
    /** Primary key. */
    id: ProjectId;
    createdAt: number;
    updatedAt: number;

    /** Human label, unique across projects (duplicate names are rejected at creation). */
    name: Str256;
    description: string | null;
    /**
     * Free-form labels, parsed from a comma-separated `--tags` flag. Individual tags
     * therefore hold no commas; the db layer stores them comma-joined.
     */
    tags: string[];
};
