#!/usr/bin/env bun
/**
 * The golint gate of the sandbox server (`images/sandbox-base/server`) inside a
 * Claude Code session. CI runs the same checks in `.github/workflows/sandbox-server.yml`.
 *
 * The repository is mostly TypeScript, thus the gate costs nothing for a turn that
 * did not edit a Go file of the server:
 *   PostToolUse — for a server `.go` file only: mark the session, format the file,
 *                 and lint the server for Linux. A lint issue blocks the edit.
 *   Stop        — with no mark, exit before any process. With a mark, run the CI
 *                 checks, then clear the mark unless the stop is blocked.
 *
 * The mark means "a Go edit of the server has no check yet". The edit writes it
 * before any process starts, thus a failed lint or a missing toolchain still leaves
 * the stop check to do.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/** The lint exits with this status when it reports issues. Each other failure means that it did not run. */
const LINT_ISSUES_EXIT = 1;
const MAX_MESSAGE_LINES = 200;
const TEST_TAIL_LINES = 20;
const SERVER = "images/sandbox-base/server";

type Result = { code: number; stdout: string; output: string };

/** A process that cannot start, or a lint tool that cannot build: the check did not run. */
class ToolchainError extends Error {}

function projectDir(): string {
  const fromHarness = process.env.CLAUDE_PROJECT_DIR;
  if (fromHarness) return fromHarness;
  // .claude/hooks/sandbox-server-check.ts -> repository root
  return new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
}

const serverDir = join(projectDir(), SERVER);

function markPath(sessionId: string): string {
  const safe = (sessionId || "no-session").replace(/[^A-Za-z0-9_-]/g, "_");
  return join(tmpdir(), "inflexa-claude-hooks", `sandbox-server-${safe}`);
}

function writeMark(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
}

async function run(cmd: string[], env: Record<string, string> = {}): Promise<Result> {
  let proc;
  try {
    proc = Bun.spawn(cmd, {
      cwd: serverDir,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    throw new ToolchainError(`\`${cmd[0]}\` did not start: ${err instanceof Error ? err.message : String(err)}`);
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stdout.trim(), output: `${stdout}${stderr}`.trimEnd() };
}

/**
 * `go tool` builds a tool for the target GOOS, and macOS cannot run a Linux binary.
 * Thus the script takes the host binary from `go tool -n`, and the lint gets
 * GOOS=linux from the environment of that binary.
 */
async function lintBinary(): Promise<string> {
  const { code, stdout, output } = await run(["go", "tool", "-modfile=tools/go.mod", "-n", "inflexa-lint"]);
  if (code !== 0 || !stdout) {
    throw new ToolchainError(`\`go tool -n inflexa-lint\` failed:\n${lastLines(output, MAX_MESSAGE_LINES)}`);
  }
  return stdout;
}

async function configCheck(): Promise<Result> {
  const { code, stdout, output } = await run(["go", "tool", "-modfile=tools/go.mod", "-n", "inflexa-lint-config"]);
  if (code !== 0 || !stdout) {
    throw new ToolchainError(`\`go tool -n inflexa-lint-config\` failed:\n${lastLines(output, MAX_MESSAGE_LINES)}`);
  }
  return run([stdout, "-check"]);
}

/** `--allow-serial-runners` waits for the machine-wide lock of golangci-lint, which another session can hold. */
async function lint(binary: string): Promise<Result> {
  const result = await run([binary, "run", "--allow-serial-runners", "./..."], { GOOS: "linux" });
  if (result.code !== 0 && result.code !== LINT_ISSUES_EXIT) {
    throw new ToolchainError(`the lint did not run (exit ${result.code}):\n${lastLines(result.output, MAX_MESSAGE_LINES)}`);
  }
  return result;
}

function lastLines(text: string, n: number): string {
  return text.split("\n").slice(-n).join("\n");
}

function capped(lines: string[]): string {
  if (lines.length <= MAX_MESSAGE_LINES) return lines.join("\n");
  return [...lines.slice(0, MAX_MESSAGE_LINES - 1), `… ${lines.length - MAX_MESSAGE_LINES + 1} more lines`].join("\n");
}

/**
 * The tests log each callback retry, thus the end of a failed run holds only log
 * lines. The summary takes the failed tests, their assertion messages, each panic,
 * and each build error out of the whole output, then adds the end. go test indents
 * each continuation line of a multi-line assertion deeper than its
 * `<name>_test.go:<line>:` line, thus the lines that follow with a deeper indent
 * belong to the message.
 */
function testSummary(output: string): string {
  const lines = output.split("\n");
  const indent = (l: string) => l.length - l.trimStart().length;
  const keep: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i] ?? "";
    if (/^\s+[\w.-]+_test\.go:\d+:/.test(l)) {
      keep.push(l);
      const depth = indent(l);
      while (i + 1 < lines.length && (lines[i + 1] ?? "").trim() !== "" && indent(lines[i + 1] ?? "") > depth) {
        i += 1;
        keep.push(lines[i] ?? "");
      }
      continue;
    }
    if (/^\s*--- FAIL/.test(l) || /^FAIL\b/.test(l) || /^panic:/.test(l) || /^[\w./-]+\.go:\d+:\d+:/.test(l)) {
      keep.push(l);
    }
  }
  return capped([...keep, "", `The last ${TEST_TAIL_LINES} lines:`, ...lines.slice(-TEST_TAIL_LINES)]);
}

function notice(message: string, extra: Record<string, unknown> = {}): never {
  console.log(JSON.stringify({ systemMessage: `The Go check of the sandbox server did not run: ${message}`, ...extra }));
  process.exit(0);
}

async function onEdit(input: any): Promise<void> {
  const raw: string = input.tool_input?.file_path ?? "";
  if (!raw) process.exit(0);
  const file = resolve(input.cwd ?? process.cwd(), raw);
  const inServer = relative(serverDir, file);
  if (!inServer || inServer.startsWith("..") || isAbsolute(inServer) || !file.endsWith(".go")) process.exit(0);

  writeMark(markPath(input.session_id ?? ""));

  const reformatted =
    "The formatter of the lint configuration changed the file. The file on disk differs from the text that you wrote. Read it again before the next edit.";
  const reformatContext = { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: reformatted } };
  let changed = false;
  let fmtFailure = "";
  try {
    const binary = await lintBinary();
    const before = existsSync(file) ? readFileSync(file) : null;
    // fmt exits 0 on a syntax error, and fails only when it cannot process the file,
    // for example a removed file. The lint still gives the result, thus a fmt
    // failure alone blocks nothing.
    const fmt = await run([binary, "fmt", file]);
    if (fmt.code !== 0) {
      fmtFailure = `\`inflexa-lint fmt\` failed (exit ${fmt.code}):\n${lastLines(fmt.output, MAX_MESSAGE_LINES)}`;
    }
    changed = before !== null && existsSync(file) && !before.equals(readFileSync(file));

    const result = await lint(binary);
    if (result.code === LINT_ISSUES_EXIT) {
      const report = capped(result.output.split("\n"));
      console.error(
        `${changed ? `${reformatted}\n\n` : ""}${fmtFailure ? `${fmtFailure}\n\n` : ""}The lint of the sandbox server reports issues (${SERVER}):\n${report}`,
      );
      process.exit(2);
    }
  } catch (err) {
    if (!(err instanceof ToolchainError)) throw err;
    notice(err.message, changed ? reformatContext : {});
  }

  if (fmtFailure) {
    console.log(
      JSON.stringify({
        systemMessage: `The formatter of the sandbox server did not run (${SERVER}): ${fmtFailure}`,
        ...(changed ? reformatContext : {}),
      }),
    );
    process.exit(0);
  }
  if (changed) console.log(JSON.stringify(reformatContext));
  process.exit(0);
}

/** The order of the checks in the spec and in the CI workflow. The first failure ends the run. */
async function firstFailure(): Promise<string | null> {
  const vet = await run(["go", "vet", "./..."], { GOOS: "linux" });
  if (vet.code !== 0) return `\`GOOS=linux go vet ./...\` failed:\n${lastLines(vet.output, MAX_MESSAGE_LINES)}`;

  const config = await configCheck();
  if (config.code !== 0) {
    return `\`go tool -modfile=tools/go.mod inflexa-lint-config -check\` failed (exit ${config.code}). Change golangci/overlay.yml, then run inflexa-lint-config again:\n${lastLines(config.output, MAX_MESSAGE_LINES)}`;
  }

  const lintResult = await lint(await lintBinary());
  if (lintResult.code !== 0) return `The lint for Linux (\`inflexa-lint run ./...\`) failed:\n${capped(lintResult.output.split("\n"))}`;

  const test = await run(["go", "test", "./..."]);
  if (test.code !== 0) return `\`go test ./...\` failed:\n${testSummary(test.output)}`;

  return null;
}

async function onStop(input: any): Promise<void> {
  const mark = markPath(input.session_id ?? "");
  if (!existsSync(mark)) process.exit(0);

  let failure: string | null;
  try {
    failure = await firstFailure();
  } catch (err) {
    if (!(err instanceof ToolchainError)) throw err;
    rmSync(mark, { force: true });
    notice(err.message);
  }

  if (failure === null) {
    rmSync(mark, { force: true });
    process.exit(0);
  }
  // A second stop after a block ends the loop: the agent could not correct the failure.
  if (input.stop_hook_active) {
    rmSync(mark, { force: true });
    console.log(JSON.stringify({ systemMessage: `The sandbox server check failed (${SERVER}):\n${failure}` }));
    process.exit(0);
  }
  console.error(`The sandbox server check failed (${SERVER}). Correct it before you stop:\n${failure}`);
  process.exit(2);
}

async function main() {
  const input = JSON.parse((await Bun.stdin.text()) || "{}");
  const event: string = input.hook_event_name ?? "";
  if (event === "PostToolUse") await onEdit(input);
  if (event === "Stop") await onStop(input);
  process.exit(0);
}

main().catch((err) => {
  // A hook must never stop work, but a silent one is a fake gate: say so.
  const message = err instanceof Error ? err.message : String(err);
  console.log(JSON.stringify({ systemMessage: `The sandbox server hook did not run: ${message}` }));
  process.exit(0);
});
