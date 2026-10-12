#!/usr/bin/env bun
/**
 * Runs oxlint on each edited TypeScript file, with the `oxlint.config.ts` of the
 * subsystem the file lives in. The search walks up from the file to the nearest
 * ancestor that holds an `oxlint.config.ts`; a subsystem without one is not
 * linted — the hook exits silently, so it stays inert there until that subsystem
 * moves to oxlint.
 *
 * A lint report goes to stderr and exits 2, the convention of the neighboring
 * hooks, so the agent sees the report.
 */

import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const TIMEOUT_MS = 60_000;

interface ToolEvent {
  cwd?: string;
  tool_input?: { file_path?: string };
}

async function main(): Promise<void> {
  const input: ToolEvent = JSON.parse((await Bun.stdin.text()) || "{}");
  const raw: string = input.tool_input?.file_path ?? "";
  if (!raw) process.exit(0);
  if (!raw.endsWith(".ts") && !raw.endsWith(".tsx")) process.exit(0);
  const file = resolve(input.cwd ?? process.cwd(), raw);

  let dir = dirname(file);
  for (;;) {
    if (existsSync(join(dir, "oxlint.config.ts"))) break;
    const parent = dirname(dir);
    if (parent === dir) process.exit(0);
    dir = parent;
  }

  const run = Bun.spawnSync({
    cmd: ["bun", "--bun", "oxlint", "--config", join(dir, "oxlint.config.ts"), relative(dir, file)],
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    timeout: TIMEOUT_MS,
  });
  if (run.exitCode === 0) process.exit(0);
  const report = run.stdout.toString().trim() || run.stderr.toString().trim();
  console.error(report);
  process.exit(2);
}

await main();
