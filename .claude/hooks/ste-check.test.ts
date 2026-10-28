/**
 * The command entry point of the STE gate (`ste-check.ts --file <path>`), which a
 * person and a CI job share with the hook. Run it from this directory
 * (`cd .claude/hooks && bun test`): the bunfig of the root refuses each test run
 * there.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "ste-check.ts");
/** The word traps come from the CLAUDE.md of this root. */
const ROOT = join(import.meta.dir, "..", "..");

const dir = mkdtempSync(join(tmpdir(), "ste-check-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs the gate on a markdown file that holds `text`. */
function check(name: string, text: string): { exitCode: number; stdout: string } {
  const path = join(dir, `${name}.md`);
  writeFileSync(path, text);
  const run = Bun.spawnSync([process.execPath, HOOK, "--file", path], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
  });
  return { exitCode: run.exitCode, stdout: run.stdout.toString() };
}

describe("quoted text", () => {
  test("the gate reports a contraction and a word trap in prose", () => {
    const result = check("prose", "Don't utilize the cache.\n");

    expect(result.stdout).toContain('[hard] contraction: "Don\'t"');
    expect(result.stdout).toContain('[hard] word-trap: "utilize"');
    expect(result.exitCode).toBe(1);
  });

  test("the gate skips text in straight double quotes", () => {
    const result = check("straight", 'The log shows "Don\'t utilize the cache".\n');

    expect(result.stdout).toContain("no finding");
    expect(result.exitCode).toBe(0);
  });

  test("the gate skips text in curly double quotes", () => {
    const result = check("curly", "The log shows “Don't utilize the cache”.\n");

    expect(result.stdout).toContain("no finding");
    expect(result.exitCode).toBe(0);
  });

  test("the gate skips a markdown blockquote", () => {
    const result = check("blockquote", "The log shows this line:\n\n> Don't utilize the cache.\n");

    expect(result.stdout).toContain("no finding");
    expect(result.exitCode).toBe(0);
  });
});

describe("sentence split", () => {
  // Each sentence is under the cap of 25 words, and the two together are over it.
  const first = "The first sentence of this paragraph gives a fact and then it cites a source";
  const second = "The second sentence of this paragraph gives a fact and it cites no source.";

  test("a citation before the period ends the sentence", () => {
    const result = check("citation", `${first} [20]. ${second}\n`);

    expect(result.stdout).toContain("no finding");
    expect(result.exitCode).toBe(0);
  });

  test("the cap applies to one sentence with no split", () => {
    const result = check("joined", `${first} and ${second}\n`);

    expect(result.stdout).toContain('[hard] sentence-length: "30 words:');
    expect(result.exitCode).toBe(1);
  });
});
