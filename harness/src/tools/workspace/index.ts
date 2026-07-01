/**
 * Workspace barrel — the workspace tool surfaces.
 *
 * Read surface (sandbox-independent): semantic file search, raw read + grep
 * over the workspace filesystem seam, plus file/plan display.
 *
 * Mutate surface (sandbox-gated): `execute_command` (single chokepoint for
 * sandbox commands), `write_file` and `edit_file` scoped to the step's
 * writable artifact directory. Each mutate factory captures a `SandboxClient`
 * and the step coordinates; only `execute_command` is permitted to drive
 * sandbox-server's `/exec` — `write_file` / `edit_file` ride the same
 * submit/await path through `runSandboxExec`.
 */

// Read surface
export * from "./workspace-search.js";
export * from "./show-file.js";
export * from "./show-plan.js";
export * from "./read-file.js";
export * from "./list-files.js";
export * from "./file-stat.js";
export * from "./grep.js";

// Mutate surface
export * from "./mutator.js";
export * from "./execute-command.js";
export * from "./write-file.js";
export * from "./edit-file.js";
export { EXEC_STREAM_BYTE_CAP, boundExecResult } from "./result-bounds.js";
export type { BoundedExecResult } from "./result-bounds.js";
