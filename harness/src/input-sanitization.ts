/**
 * Input sanitization — pure, always-on text functions, not a plug-in pipeline.
 * What runs is exactly what is declared here.
 *
 * `normalizeUnicode` and `redactSecrets` are applied once to the incoming user
 * message by the chat route, and never to assistant messages or to the result
 * that a tool gives the model. `stripNulCharacters` is the exception — it
 * applies to tool results.
 *
 * `redactSecretForms`, `redactSecretFields`, and `redactSecretAssignments` are
 * the value-only rules: only the shown values of a tool call (`loop/tool-value.ts`)
 * get them. They are name-based rules that would mark prose and sequences in a
 * user message. The model reads the unchanged result.
 */

import { isUnknownArray } from "./lib/unknown-array.js";
import { parseUnknownRecord } from "./lib/unknown-containers.js";

/**
 * C0/C1 control characters and DEL, excluding `\t` (U+0009) and `\n`
 * (U+000A) which are legitimate whitespace in user prose.
 */
// oxlint-disable-next-line no-control-regex, eslint-js/no-restricted-syntax -- matching control characters is the intent: this pattern strips invisible C0/C1 bytes and DEL from untrusted user input (see `normalizeUnicode` below).
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * NFC-normalize and strip control characters.
 *
 * Unicode normalization collapses visually-identical decomposed sequences
 * to a canonical form; control-char stripping removes invisible C0/C1 bytes
 * that could smuggle formatting or terminal escapes.
 */
export function normalizeUnicode(text: string): string {
    return text.normalize("NFC").replace(CONTROL_CHARS, "");
}

/**
 * NUL (U+0000) — the one character a stored message cannot carry. Postgres
 * refuses it inside JSON: a `jsonb` column rejects the insert outright, and a
 * `json` column accepts it but errors the moment a JSON operator reads that row
 * ("U+0000 cannot be converted to text"), which is what `retractLastTurn`'s
 * boundary predicate does. Either way one NUL byte poisons a thread, and it
 * arrives through no fault of the model: tool results carry raw command output
 * and file bytes, which is why they are otherwise left unsanitized.
 */
// oxlint-disable-next-line no-control-regex, eslint-js/no-restricted-syntax -- matching NUL is the intent; see above.
const NUL = /\u0000/g;

/**
 * Strip every NUL from `text`. Applied where a tool result is built — so the
 * loop's in-memory message and the stored row agree byte-for-byte and the
 * prompt-cache prefix survives the round trip — and again where the turn is
 * written, which holds the invariant for writers that are not the loop. User
 * input needs no separate treatment: `normalizeUnicode` already strips NUL along
 * with the rest of the C0 range.
 */
export function stripNulCharacters(text: string): string {
    return text.replace(NUL, "");
}

/**
 * Each entry redacts one structured, prefixed secret format. Every pattern
 * has a prefix (`AKIA`, `sk-`, `gh*_`, `eyJ`, `Bearer`, a DB scheme) that
 * cannot collide with a nucleotide or protein sequence — so none of these
 * false-positive on biological data.
 *
 * The 40-char generic AWS secret pattern and the loose `key:value` "Generic
 * Secret Assignment" pattern are intentionally absent — both are domain-blind
 * and false-positive on nucleotide / protein sequences.
 *
 * Order matters: `sk-ant-` is redacted before the generic `sk-` so the
 * Anthropic label wins; `sk-(?!ant-)` additionally excludes it by lookahead.
 */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the AWS access-key format with its fixed AKIA prefix and 16-character id body.
    { name: "AWS Access Key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the Anthropic key format with its sk-ant- prefix and base64url body.
    { name: "Anthropic API Key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the generic OpenAI sk- format; the (?!ant-) lookahead keeps the Anthropic label ahead of it.
    { name: "OpenAI API Key", pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the GitHub token format with its gh*_ prefix and 36-character body.
    { name: "GitHub Token", pattern: /\bgh[psoru]_[A-Za-z0-9_]{36,}\b/g },
    {
        name: "JWT Token",
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the three dot-separated base64url JWT segments after the eyJ signature prefix.
        pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    },
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the Bearer scheme with its token characters and padding, the header form of a leaked credential.
    { name: "Bearer Token", pattern: /\bBearer\s+[A-Za-z0-9_\-.~+/]+=*/gi },
    {
        name: "Connection String",
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the DB connection schemes with their :// and unquoted authority, the connection-string form of a leaked credential.
        pattern: /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp|mssql):\/\/[^\s"'`]+/gi,
    },
];

/**
 * Replace structured secret formats with `[REDACTED: <name>]`.
 *
 * Only prefixed formats are matched — a 40-nucleotide `ACGT…` string or a
 * 40-residue protein sequence passes through unchanged.
 */
export function redactSecrets(text: string): string {
    let out = text;
    for (const { name, pattern } of SECRET_PATTERNS) {
        out = out.replace(pattern, `[REDACTED: ${name}]`);
    }
    return out;
}

/**
 * The words that end the name of a field that holds a secret. A name is compared with the case, `_`, and `-` removed.
 * The name must END with the word, not hold it: `max_tokens`, `tokenizer`, and `tokenCount` hold no secret. `pass` also
 * ends a name such as `bypass`, which costs a shown fact only. `pwd` is not a word: `PWD` is the working directory.
 */
const SECRET_NAME_WORDS: readonly string[] = [
    "password",
    "passwd",
    "pass",
    "secret",
    "secretkey",
    "token",
    "apikey",
    "accesskey",
    "privatekey",
    "credential",
    "credentials",
    "authorization",
    "cookie",
];

function isSecretName(name: string): boolean {
    const folded = name.toLowerCase().replaceAll("_", "").replaceAll("-", "");
    return SECRET_NAME_WORDS.some((word) => folded.endsWith(word));
}

const SECRET_FIELD_MARKER = "[REDACTED: Secret Field]";
const SECRET_ASSIGNMENT_MARKER = "[REDACTED: Secret Assignment]";
const PASSWORD_MARKER = "[REDACTED: Password]";
const SECRET_FLAG_MARKER = "[REDACTED: Secret Flag]";

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- an argv element that is a long option, `--name`, with no value in it. The name is bounded, thus the test of an element is bounded.
const ARGV_FLAG = /^--([A-Za-z0-9][A-Za-z0-9_.-]{0,80})$/;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the credential of an argv element after `-u` or `--user`: the user, a colon, and the password to the end of the element. The user holds no colon, so the match has one reading.
const ARGV_CREDENTIAL = /^([^:]*):[\s\S]*$/;

/**
 * A copy of an array of strings in which the element after a `--name` element with a secret name is the redaction
 * marker, and the element after `-u` or `--user` loses its password. A command line that is an array of words has no
 * text in which the flag rules can see the flag and its value together.
 */
function redactArgvValues(array: readonly unknown[]): unknown[] {
    return array.map((element, index) => {
        const before = array[index - 1];
        if (typeof element !== "string" || typeof before !== "string") return redactSecretFields(element);
        if (before === "-u" || before === "--user") return element.replace(ARGV_CREDENTIAL, `$1:${PASSWORD_MARKER}`);
        const flag = ARGV_FLAG.exec(before);
        if (flag?.[1] !== undefined && isSecretName(flag[1]) && !element.startsWith("--")) return SECRET_FLAG_MARKER;
        return element;
    });
}

/**
 * A copy of a JSON value in which the value of each object field with a secret name is the redaction marker. The
 * walk goes to each depth, thus the `GITHUB_TOKEN` field of an `env` object is found. An array applies the rule of
 * {@link redactArgvValues} to its strings. The rule belongs to the values of a tool call only. `redactSecrets` stays
 * free of any name-based rule, because a user message holds prose and sequences that such a rule would mark.
 */
export function redactSecretFields(value: unknown): unknown {
    if (isUnknownArray(value)) return redactArgvValues(value);
    const record = parseUnknownRecord(value);
    if (record === undefined) return value;
    const out: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(record)) {
        out[name] = isSecretName(name) && field !== null && field !== undefined ? SECRET_FIELD_MARKER : redactSecretFields(field);
    }
    return out;
}

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the shell and environment form NAME=value, with a quoted value that ends at its closing quote (an escaped quote inside a double-quoted value does not end it) or a value up to the next separator. A quote that does not close holds the rest of the text, because a cut text can end inside a secret. A name has at most 80 characters, thus a long run of name characters costs a bounded scan at each start. A value does not start with `=`, thus a comparison `token == x` stays whole, and a value that an earlier rule already replaced stays as it is.
const ASSIGNMENT = /([A-Za-z0-9_.-]{1,80})=(?!=|\[REDACTED: [A-Za-z ]{1,30}\])("(?:[^"\\]|\\.)*(?:"|\\?$)|'[^']*(?:'|$)|[^\s"'\\&;,]+)/g;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- a quoted field `"name": value`. The value is a string that ends at its closing quote (an escaped quote inside it does not end it, and a quote that does not close holds the rest of the text), or a number or a bare word that ends at a separator. A bare value does not start a nested object or array.
const QUOTED_FIELD = /"([^"\\\s]{1,80})"(\s*:\s*)(?:"((?:[^"\\]|\\.)*)(?:"|\\?$)|([^\s",}\]{[][^\s",}\]]*))/g;

/**
 * Replace the value of each `NAME=value` assignment and of each quoted `"name": value` field whose name ends with a
 * secret word. A caller runs it on a plain text or on one string of a JSON value, never on serialized JSON, because a
 * JSON escape hides the quotes that the rules read. It runs on the text of a tool call value only. See
 * {@link redactSecretFields}.
 */
export function redactSecretAssignments(text: string): string {
    return text
        .replace(ASSIGNMENT, (whole, name: string) => (isSecretName(name) ? `${name}=${SECRET_ASSIGNMENT_MARKER}` : whole))
        .replace(QUOTED_FIELD, (whole, name: string, colon: string, quoted: string | undefined) => {
            if (!isSecretName(name)) return whole;
            return quoted === undefined ? `"${name}"${colon}${SECRET_FIELD_MARKER}` : `"${name}"${colon}"${SECRET_FIELD_MARKER}"`;
        });
}

const PRIVATE_KEY_MARKER = "[REDACTED: Private Key]";
const URL_PASSWORD_MARKER = "[REDACTED: URL Password]";
const SECRET_PAIR_MARKER = "[REDACTED: Secret Pair]";
const COOKIE_MARKER = "[REDACTED: Cookie]";

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the begin line and the end line of a PEM private-key block. The label is bounded and holds no newline, thus each line is read once.
const PRIVATE_KEY_LINE = /-----(BEGIN|END) [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;

/**
 * Replace each private-key block, from its begin line to its end line. A begin line with no end line hides the rest of
 * the text. An end line with no begin line before it hides the text from the start of the text, or from the end of the
 * block before it, because a window or a cut can start inside a block.
 */
function redactPrivateKeyBlocks(text: string): string {
    let out = "";
    let copied = 0;
    let blockStart = -1;
    for (const line of text.matchAll(PRIVATE_KEY_LINE)) {
        if (line[1] === "BEGIN") {
            if (blockStart < 0) blockStart = line.index;
            continue;
        }
        out += text.slice(copied, blockStart >= 0 ? blockStart : copied) + PRIVATE_KEY_MARKER;
        copied = line.index + line[0].length;
        blockStart = -1;
    }
    if (blockStart >= 0) return out + text.slice(copied, blockStart) + PRIVATE_KEY_MARKER;
    return out + text.slice(copied);
}

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- a URL with a user and a password, `scheme://user:password@host`. The user holds no colon, so the match has one reading, and the password ends at the first `@`, `/`, or space.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/?#"'`]{0,200}):[^\s@/"'`]{1,500}@/gi;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the `-u user:password` and `--user user:password` options of curl and similar tools, with an unquoted, a double-quoted, or a single-quoted credential. The user holds no colon, so the match has one reading.
const USER_OPTION = /(^|\s)(-u|--user)(\s+|=)(?:"([^":\s]*):[^"]*"?|'([^':\s]*):[^']*'?|([^\s:"']*):\S*)/g;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- a `Cookie` or `Set-Cookie` header, whose value runs to the end of its line.
const COOKIE_HEADER = /(^|\s)((?:Set-)?Cookie)([ \t]*:[ \t]*)[^\r\n]+/gi;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- a command flag `--name value` or `--name=value`. The value is a quoted string (a quote that does not close holds the rest of the text) or the next word. A word that starts a flag is no value.
const COMMAND_FLAG = /(^|\s)--([A-Za-z0-9][A-Za-z0-9_.-]{0,80})(=|\s+)(?!--)("(?:[^"\\]|\\.)*(?:"|\\?$)|'[^']*(?:'|$)|\S+)/g;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the start of a `name: value` pair of a header or of YAML: the name after a line start, a space, a comma, an opening bracket, or an opening quote, then its colon. The name has at most 80 characters, thus the scan at each start is bounded.
const PAIR_START = /(^|[\s,{("'])([A-Za-z][A-Za-z0-9_.-]{0,80})[ \t]*:[ \t]*/gm;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the value of a `name: value` pair, read at the end of its start: a quoted string, or the text up to the end of the line or the next quote.
const PAIR_VALUE = /"(?:[^"\\\r\n]|\\.)*"?|'[^'\r\n]*'?|[^\r\n"']+/y;

/**
 * Replace the value of each `name: value` pair whose name ends with a secret word. The scan goes on after the colon of
 * a name that holds no secret, thus a secret pair later on the same line is found. Each step moves forward, thus the
 * cost is linear.
 */
function redactNameValuePairs(text: string): string {
    // The patterns carry `lastIndex`, and this function runs to its end with no await, thus no call reads it between two steps of another.
    const start = PAIR_START;
    const value = PAIR_VALUE;
    start.lastIndex = 0;
    let out = "";
    let copied = 0;
    for (let pair = start.exec(text); pair !== null; pair = start.exec(text)) {
        const name = pair[2] ?? "";
        const end = pair.index + pair[0].length;
        if (!isSecretName(name)) {
            // The blanks after the colon stay available as the lead of the next name.
            start.lastIndex = end - (pair[0].length - pair[0].trimEnd().length);
            continue;
        }
        value.lastIndex = end;
        const shown = value.exec(text);
        if (shown === null) continue;
        out += `${text.slice(copied, end)}${SECRET_PAIR_MARKER}`;
        copied = end + shown[0].length;
        start.lastIndex = copied;
    }
    return out + text.slice(copied);
}

/**
 * Replace the secret that each of these forms holds: a private-key block, the password of a URL, the password of a
 * `-u user:password` option, the value of a `Cookie` header, the value of a `--name value` flag, the value of a
 * `name: value` pair, and each form of {@link redactSecretAssignments}. A name must end with a secret word.
 * It covers these forms only: a text can hold a secret in a different form. It runs on the text of a tool call value
 * only, on a plain text or on one string of a JSON value.
 */
export function redactSecretForms(text: string): string {
    const withoutKeys = redactPrivateKeyBlocks(text);
    const withoutUrlPasswords = withoutKeys.replace(URL_PASSWORD, `$1:${URL_PASSWORD_MARKER}@`);
    const withoutUserOptions = withoutUrlPasswords.replace(
        USER_OPTION,
        (_whole, lead: string, option: string, joint: string, double: string | undefined, single: string | undefined, bare: string | undefined) => {
            const quote = double !== undefined ? '"' : single !== undefined ? "'" : "";
            const user = double ?? single ?? bare ?? "";
            return `${lead}${option}${joint}${quote}${user}:${PASSWORD_MARKER}${quote}`;
        },
    );
    const withoutCookies = withoutUserOptions.replace(COOKIE_HEADER, `$1$2$3${COOKIE_MARKER}`);
    const withoutFlags = withoutCookies.replace(COMMAND_FLAG, (whole, lead: string, name: string, joint: string) =>
        isSecretName(name) ? `${lead}--${name}${joint}${SECRET_FLAG_MARKER}` : whole,
    );
    return redactSecretAssignments(redactNameValuePairs(withoutFlags));
}
