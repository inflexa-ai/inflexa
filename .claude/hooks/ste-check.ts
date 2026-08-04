#!/usr/bin/env bun
/**
 * ASD-STE100 Simplified Technical English gate for this repository.
 *
 * Part 2 of the standard (the dictionary) is not redistributable, so nothing here
 * embeds it. Every lexical rule is read at runtime from the `### Word traps` table
 * in CLAUDE.md: one source of truth, and no copy of the standard in a public repo.
 *
 * Findings carry a confidence class because only the commit surface blocks:
 *   hard — deterministic; no part-of-speech or context judgment is possible to get
 *          wrong. Only these can deny a commit.
 *   soft — heuristic (voice, tense, words whose legality depends on part of speech).
 *          Advice only.
 * A gate that denies on a guess teaches people to route around it, so the blocking
 * set is deliberately the narrow one and grows only if a rule proves deterministic.
 *
 * Two entry points share one checker. As a hook it reads the tool call on stdin and
 * answers with the hook protocol. As `ste-check.ts --file <path>` it prints a plain
 * report and exits 1 on a hard finding, so a person and a CI job get the same verdict.
 */

type Severity = "hard" | "soft";

type Finding = {
  rule: string;
  severity: Severity;
  where: string;
  quote: string;
  hint: string;
};

type Trap = { pattern: RegExp; replacement: string; severity: Severity };

/** Rule 5.1 (an instruction) and rule 6.3 (a description). */
const MAX_WORDS_PROCEDURAL = 20;
const MAX_WORDS_DESCRIPTIVE = 25;
/** Rule 6.6. */
const MAX_SENTENCES_PER_PARAGRAPH = 6;

/**
 * A word trap whose left cell carries a parenthetical qualifier — `check (verb)`,
 * `follow (a rule)`, `since (a cause)` — is legal in the other reading, and no regex
 * can tell the two apart. The qualifier is therefore the marker for "advise, never
 * deny", which is why CLAUDE.md's notation is load-bearing here.
 */
const QUALIFIED = /\s*\(/;

/**
 * `main` is a branch name, a file name, and an entry point in this repository far
 * more often than it is the adjective the standard rejects. Denying on it would fire
 * on `origin/main` in every other commit message.
 */
const FORCED_SOFT = new Set(["main"]);

function projectDir(): string {
  const fromHarness = process.env.CLAUDE_PROJECT_DIR;
  if (fromHarness) return fromHarness;
  // .claude/hooks/ste-check.ts -> repository root
  return new URL("../..", import.meta.url).pathname;
}

/** Reads the word traps out of CLAUDE.md so the table stays the only place they live. */
async function loadTraps(): Promise<Trap[]> {
  const path = `${projectDir()}/CLAUDE.md`;
  const text = await Bun.file(path).text();
  const section = text.split(/^### Word traps$/m)[1];
  if (!section) throw new Error(`no "### Word traps" table in ${path}`);

  const traps: Trap[] = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) {
      if (traps.length > 0) break; // the table ended
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    if (cells[0] === "Do not use" || /^-+$/.test(cells[0])) continue;

    for (const raw of cells[0].split(",")) {
      const entry = raw.trim();
      if (!entry) continue;
      const word = entry.replace(/\s*\(.*$/, "").trim();
      const severity: Severity =
        QUALIFIED.test(entry) || FORCED_SOFT.has(word) ? "soft" : "hard";
      traps.push({
        pattern: new RegExp(`\\b${word.replace(/\s+/g, "\\s+")}\\b`, "gi"),
        replacement: cells[1],
        severity,
      });
    }
  }
  if (traps.length === 0) throw new Error(`empty word-trap table in ${path}`);
  return traps;
}

const CONTRACTIONS =
  /\b(\w+n['’]t|(?:it|that|there|here|what|who|let|he|she)['’]s|\w+['’](?:ll|ve|re|d|m))\b/gi;
const LATIN = /\b(e\.g\.|i\.e\.|etc\.|viz\.|cf\.|et al\.|vs\.)/gi;
const GENDERED = /\b(he|she|him|her|his|hers|himself|herself)\b/gi;
/**
 * Rule 1.14. British forms only — a word whose American spelling is identical is
 * absent, so a match is always a real violation.
 */
const BRITISH =
  /\b(colour|colours|behaviour|behaviours|favour|favours|centre|centres|metre|metres|fibre|fibres|licence|defence|catalogue|analyse|analysed|organise|organised|initialise|initialised|normalise|normalised|serialise|serialised|grey|labelled|cancelled|travelled)\b/gi;

const PROGRESSIVE = /\b(is|are|was|were|be|been|being)\s+(\w+ing)\b/gi;
const PERFECT = /\b(have|has|had)\s+(\w+(?:ed|en))\b/gi;
/**
 * Rule 3.6 permits the passive in a description when the agent is unknown, and no
 * parser can decide whether an agent is knowable. Only the form that names its agent
 * with `by` is unambiguously rejected, so only that form is reported.
 */
const PASSIVE = /\b(is|are|was|were|be|been)\s+\w+(?:ed|en)\s+by\b/gi;
/** Rule 3.5. Connectives whose `-ing` form is never a technical name. */
const ING_CONNECTIVE =
  /\b(following|regarding|according|concerning|depending|including|using|being|having|ensuring|allowing|providing|containing|requiring)\b/gi;

/**
 * Word count under rules 8.4 thru 8.7: an identifier, a number with its unit, an
 * abbreviation, quoted text, a parenthetical, and a hyphenated group each count as
 * one word. Without this the limits would punish exactly the technical prose the
 * standard exempts.
 */
function countWords(sentence: string): number {
  const collapsed = sentence
    .replace(/`[^`]*`/g, " X ")
    .replace(/\([^)]*\)/g, " X ")
    .replace(/"[^"]*"/g, " X ")
    .replace(/[“][^”]*[”]/g, " X ")
    .replace(/\b\d[\d.,]*\s*[A-Za-z%°]*\b/g, " X ")
    .replace(/\b[A-Z]{2,}(?:-[A-Z0-9]+)*\b/g, " X ")
    .replace(/\b[\w]+(?:-[\w]+)+\b/g, " X ");
  return collapsed.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

/**
 * Strips everything the standard does not govern. Quoted text (rule 8.6), code, and
 * table cells are exempt — and the exemption is not cosmetic: CLAUDE.md's own trap
 * table and its deliberately non-STE example would otherwise report themselves.
 */
function markdownProse(source: string): string[] {
  const body = source.replace(/^---\n[\s\S]*?\n---\n/, "");
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  // Inline spans are stripped only after the wrapped lines are joined: a `code span`
  // broken across two source lines has no closing backtick on either one, and a
  // per-line strip would leave its contents exposed as prose.
  const flush = () => {
    if (current.length === 0) return;
    blocks.push(
      current
        .join(" ")
        .replace(/<!--[\s\S]*?-->/g, "")
        // Padded on the left only. A trailing pad would put a space between the
        // placeholder and a sentence-ending period, and the splitter's lookbehind
        // would then miss the terminator and merge two sentences into one count.
        .replace(/`[^`]*`/g, " `X`")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/https?:\/\/\S+/g, "X")
        // The standard regulates content, not formatting, so emphasis markers are
        // noise here — and worse, a sentence wrapped as **… .** hides its own
        // terminator behind the asterisks, so two sentences would be counted as one.
        .replace(/\*\*|\*/g, ""),
    );
    current = [];
  };

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      flush();
      continue;
    }
    if (inFence) continue;
    if (line === "" || line.startsWith("|") || line.startsWith(">") || line.startsWith("#")) {
      flush();
      continue;
    }
    // A list item is its own unit; a wrapped paragraph line continues the previous one.
    if (/^([-*+]|\d+\.)\s/.test(line)) flush();
    current.push(line);
  }
  flush();
  return blocks;
}

/** Rule 8.4: a colon that introduces a vertical list ends the sentence, like a period. */
function splitSentences(block: string): string[] {
  return block
    .split(/(?<=[a-zA-Z0-9`)"'”])[.!?:](?=\s|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function checkText(where: string, traps: Trap[], maxWords: number, blocks: string[]): Finding[] {
  // Every lexical rule reads the stripped prose, never the raw source. Code, quoted
  // text, and table cells are outside STE, and scanning them would make any document
  // that discusses the rules — CLAUDE.md above all — report itself.
  const text = blocks.join("\n");
  const findings: Finding[] = [];
  const add = (rule: string, severity: Severity, quote: string, hint: string) =>
    findings.push({ rule, severity, where, quote: quote.trim(), hint });

  for (const [re, rule, severity, hint] of [
    [CONTRACTIONS, "contraction", "hard", "Write the words in full (rule 4.2)"],
    [LATIN, "latin-abbreviation", "hard", "Write `for example` or `that is` (GR-6)"],
    [GENDERED, "gendered-pronoun", "hard", "Use a gender-neutral word (GR-7)"],
    [BRITISH, "british-spelling", "hard", "Use American English spelling (rule 1.14)"],
    [PROGRESSIVE, "progressive-tense", "soft", "Use the simple present tense (rule 3.2)"],
    [PERFECT, "perfect-tense", "soft", "Use the simple past tense (rule 3.4)"],
    [PASSIVE, "passive-voice", "soft", "Use the active voice (rule 3.6)"],
    [ING_CONNECTIVE, "ing-form", "soft", "Use a clause with a verb (rule 3.5)"],
  ] as const) {
    for (const m of text.matchAll(re)) add(rule, severity, m[0], hint);
  }

  for (const trap of traps) {
    for (const m of text.matchAll(trap.pattern)) {
      add("word-trap", trap.severity, m[0], `Use \`${trap.replacement}\``);
    }
  }

  if (text.includes(";")) add("semicolon", "hard", ";", "Write two sentences (rule 8.1)");

  for (const block of blocks) {
    const sentences = splitSentences(block);
    if (sentences.length > MAX_SENTENCES_PER_PARAGRAPH) {
      add(
        "paragraph-length",
        "soft",
        `${sentences.length} sentences`,
        `Use a maximum of ${MAX_SENTENCES_PER_PARAGRAPH} sentences (rule 6.6)`,
      );
    }
    for (const sentence of sentences) {
      const n = countWords(sentence);
      if (n > maxWords) {
        add("sentence-length", "hard", `${n} words: ${sentence.slice(0, 60)}…`, `Use a maximum of ${maxWords} words`);
      }
    }
  }
  return findings;
}

/** Pulls the quoted value of a repeated flag out of a shell command. */
function flagValues(command: string, flag: string): string[] {
  const re = new RegExp(`${flag}\\s+(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`, "g");
  return [...command.matchAll(re)].map((m) => (m[1] ?? m[2] ?? "").replace(/\\"/g, '"'));
}

/**
 * Drops every quoted span, so a flag scan reads only real flags. Without this,
 * a message such as -m "use -s to sign off" would look like a signed commit.
 */
function withoutQuotedText(command: string): string {
  return command.replace(/"(?:[^"\\]|\\.)*"/g, " ").replace(/'[^']*'/g, " ");
}

/**
 * CLAUDE.md requires a sign-off on each commit. Three details decide the match:
 * `-s` bundles into a short-flag cluster such as `-sm`; git reads uppercase `-S` as
 * GPG signing, which is a different thing, so the scan is case-sensitive; and
 * `--no-signoff` cancels an earlier flag. `--amend` gets no exemption, because git
 * does not repeat an identical trailer, thus the flag there costs nothing and keeps
 * the sign-off through a rewrite.
 */
function hasSignoff(command: string, message: string): boolean {
  const flags = withoutQuotedText(command);
  if (/(?:^|\s)--no-signoff(?=\s|$)/.test(flags)) return false;
  if (/(?:^|\s)--signoff(?=\s|$)/.test(flags)) return true;
  if (/(?:^|\s)-[a-zA-Z]*s[a-zA-Z]*(?=\s|$)/.test(flags)) return true;
  return /^Signed-off-by:\s*\S+/m.test(message);
}

/**
 * A word of a shell command. `expands` marks a `$name`, a `$(…)`, or a backtick, which
 * only the shell resolves. The gate must report such a word as unreadable, never guess
 * at the text that it carries.
 */
type Word = { text: string; expands: boolean };

/** The flags that carry prose directly, across `gh pr` and `gh issue`. */
const TEXT_FLAGS = new Set(["--title", "-t", "--body", "-b"]);
/** The flags that name a file, or `-` for standard input. */
const FILE_FLAGS = new Set(["--body-file", "-F"]);

/**
 * A heredoc holds data, not shell words, and it is the usual source of `--body-file -`.
 * It comes out before the tokenizer runs, because a body that contains a line such as
 * `-b something` would otherwise read as a flag and its value.
 */
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\r?\n([\s\S]*?)\r?\n[ \t]*\2(?=\s|$)/g;

function takeHeredocs(command: string): { rest: string; bodies: Word[] } {
  const bodies: Word[] = [];
  const rest = command.replace(HEREDOC, (_all, quote: string, _delimiter: string, body: string) => {
    // An unquoted delimiter lets the shell expand the body, thus this text is not final.
    bodies.push({ text: body, expands: quote === "" && /[$`]/.test(body) });
    return " ";
  });
  return { rest, bodies };
}

/**
 * Splits a command into words under the quoting rules of the shell. A regex on the raw
 * text cannot do this: it misses an unquoted value, and it cannot tell `--body` from
 * `--body-file`, which is how a description reached a pull request unchecked.
 */
function tokenize(command: string): Word[] {
  const words: Word[] = [];
  let text = "";
  let expands = false;
  let open = false;

  const end = () => {
    if (open) words.push({ text, expands });
    text = "";
    expands = false;
    open = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      end();
      continue;
    }
    open = true;
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      text += command.slice(i + 1, close === -1 ? undefined : close);
      i = close === -1 ? command.length : close;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j += 1) {
        if (command[j] === "\\" && j + 1 < command.length) {
          j += 1;
          text += command[j];
          continue;
        }
        if (command[j] === "$" || command[j] === "`") expands = true;
        text += command[j];
      }
      i = j;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      i += 1;
      text += command[i];
      continue;
    }
    if (c === "$" || c === "`") expands = true;
    text += c;
  }
  end();
  return words;
}

/**
 * Collects each piece of prose that a `gh` command publishes, from whichever flag
 * carries it. A source that the gate cannot resolve goes into `unreadable` and becomes
 * a hard finding. A silent skip of an unknown source is a gate in name only.
 */
async function ghPayload(command: string): Promise<{ texts: string[]; unreadable: string[] }> {
  const { rest, bodies } = takeHeredocs(command);
  const words = tokenize(rest);
  const texts: string[] = [];
  const unreadable: string[] = [];
  let nextHeredoc = 0;

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (!word) continue;
    const split = word.text.indexOf("=");
    const name = split > 0 ? word.text.slice(0, split) : word.text;
    const isText = TEXT_FLAGS.has(name);
    if (!isText && !FILE_FLAGS.has(name)) continue;

    // `--body=text` holds its value inline. `--body text` holds it in the next word.
    // An inline value inherits the mark of its word, because half of a word that the
    // shell expands cannot be separated from the other half.
    const value: Word | undefined =
      split > 0 ? { text: word.text.slice(split + 1), expands: word.expands } : words[i + 1];

    if (!value) {
      unreadable.push(`${name} has no value`);
      continue;
    }
    if (isText) {
      if (value.expands) unreadable.push(`${name} holds a shell expansion`);
      else texts.push(value.text);
      continue;
    }
    if (value.text === "-") {
      const body = bodies[nextHeredoc];
      nextHeredoc += 1;
      if (!body) unreadable.push(`${name} reads standard input, and no heredoc supplies it`);
      else if (body.expands) unreadable.push(`${name} reads a heredoc that the shell expands`);
      else texts.push(body.text);
      continue;
    }
    if (value.expands) {
      unreadable.push(`${name} holds a shell expansion`);
      continue;
    }
    // The path resolves against the directory of the hook, which is not always the
    // directory of the command. A relative path that misses is reported, not skipped.
    const file = Bun.file(value.text);
    if (!(await file.exists())) {
      unreadable.push(`${name} names ${value.text}, which the gate cannot open`);
      continue;
    }
    texts.push(await file.text());
  }
  return { texts, unreadable };
}

/** The `gh` subcommands that publish prose. `--editor` and `--web` hand the text to a
 * person instead, and a person is outside the reach of a tool hook. */
const GH_TEXT_COMMAND = /\bgh\s+(pr|issue)\s+(create|edit|comment|review)\b/;

function ghSubject(kind: string, action: string): string {
  if (action === "comment") return "the comment";
  if (action === "review") return "the review";
  return kind === "issue" ? "the issue text" : "the pull request text";
}

function report(findings: Finding[], subject: string): string {
  const lines = [`Repository gate — ${subject}:`];
  for (const f of findings) {
    lines.push(`  [${f.severity}] ${f.rule}: "${f.quote}" — ${f.hint}`);
  }
  return lines.join("\n");
}

/**
 * The command entry point. It gives one checker to the hook, to a person, and to a CI
 * job, and it gives a `gh` body the one payload source that the gate always opens.
 *
 * Exit 0 for a clean file or a soft finding. Exit 1 for a hard finding.
 */
async function checkFile(path: string): Promise<number> {
  const traps = await loadTraps();
  const where = path.replace(`${projectDir()}/`, "");
  const source = await Bun.file(path).text();
  const findings = checkText(where, traps, MAX_WORDS_DESCRIPTIVE, markdownProse(source));
  if (findings.length === 0) {
    console.log(`Repository gate — ${where}: no finding.`);
    return 0;
  }
  console.log(report(findings, where));
  return findings.some((f) => f.severity === "hard") ? 1 : 0;
}

async function main() {
  // The command entry point answers before any read of standard input. With no hook to
  // close the stream, a read there waits on a terminal that never sends an end.
  const flag = process.argv[2] ?? "";
  if (flag === "--file" || flag.startsWith("--file=")) {
    const path = flag.startsWith("--file=") ? flag.slice("--file=".length) : process.argv[3];
    if (!path) {
      console.error("usage: ste-check.ts --file <path>");
      process.exit(2);
    }
    process.exit(await checkFile(path));
  }

  const input = JSON.parse((await Bun.stdin.text()) || "{}");
  const tool: string = input.tool_name ?? "";
  const event: string = input.hook_event_name ?? (input.tool_response ? "PostToolUse" : "PreToolUse");
  const traps = await loadTraps();

  let findings: Finding[] = [];
  let subject = "";
  let blocking = false;

  if (tool === "Bash") {
    const command: string = input.tool_input?.command ?? "";

    if (/\bgit\s+commit\b/.test(command)) {
      const message = flagValues(command, "-m").join("\n\n");
      subject = "the commit";
      blocking = true;
      // No -m means an editor or a file supplies the message; there is nothing to read.
      // The sign-off is still visible in the command, so that check runs either way.
      if (message) {
        findings = checkText(subject, traps, MAX_WORDS_PROCEDURAL, markdownProse(message));
      }
      if (!hasSignoff(command, message)) {
        findings.push({
          rule: "sign-off",
          severity: "hard",
          where: subject,
          quote: "no Signed-off-by trailer",
          hint: "Use the `-s` option of `git commit` (CLAUDE.md, Commits)",
        });
      }
    } else {
      const gh = GH_TEXT_COMMAND.exec(command);
      if (gh) {
        subject = ghSubject(gh[1] ?? "", gh[2] ?? "");
        // A description and a comment go to other people, and neither one comes back.
        // The commit surface denies for that reason, thus this surface denies too.
        blocking = true;
        const { texts, unreadable } = await ghPayload(command);
        if (texts.length > 0) {
          findings = checkText(subject, traps, MAX_WORDS_DESCRIPTIVE, markdownProse(texts.join("\n\n")));
        }
        for (const reason of unreadable) {
          findings.push({
            rule: "unreadable-payload",
            severity: "hard",
            where: subject,
            quote: reason,
            hint: "Write the text to a file. Then give `--body-file <absolute path>`",
          });
        }
      }
    }
  } else if (tool === "Write" || tool === "Edit" || tool === "MultiEdit") {
    const file: string = input.tool_input?.file_path ?? "";
    if (file.endsWith(".md")) {
      const source = await Bun.file(file).text();
      subject = file.replace(`${projectDir()}/`, "");
      findings = checkText(subject, traps, MAX_WORDS_DESCRIPTIVE, markdownProse(source));
    }
  }

  if (findings.length === 0) process.exit(0);

  const hard = findings.filter((f) => f.severity === "hard");
  if (blocking && hard.length > 0) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `${report(hard, subject)}\n\nCLAUDE.md gives these rules. Correct ${subject}, then run the command again.`,
        },
      }),
    );
    process.exit(0);
  }

  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: report(findings, subject) },
      suppressOutput: true,
    }),
  );
  process.exit(0);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  // Under the command entry point a broken checker must fail loudly, because a CI job
  // that reads exit 0 would call the text clean.
  if (process.argv.includes("--file") || process.argv.some((a) => a.startsWith("--file="))) {
    console.error(`STE check did not run: ${message}`);
    process.exit(2);
  }
  // As a hook it must never stop work, but a silent one is a fake gate: say so.
  console.log(JSON.stringify({ systemMessage: `STE hook did not run: ${message}` }));
  process.exit(0);
});
