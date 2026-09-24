## Context

The harness runs each agent through `runAgent` (`src/loop/run-agent.ts`). The loop makes the result of each dispatched call in `dispatchTool`. `successResult` (near line 971) turns an ok value into a JSON result, and `errorResult` turns a failure into an error result. No function of the loop measures the size of a result.

Two tools give large results today:

- `read_file` gives up to 262,144 bytes (`DEFAULT_MAX_BYTES`, `src/tools/workspace/read-file.ts` line 19).
- `execute_command` gives each stream up to `EXEC_STREAM_BYTE_CAP`, 32 KiB (`src/tools/workspace/result-bounds.ts` line 21).

`submitExec` sends the same 32 KiB to the sandbox as a retention budget (`src/sandbox/submit-exec.ts` near line 89). The server keeps the start of each stream up to the budget, and it drops the rest (`images/sandbox-base/server/executor.go` near line 556). The client cuts each stream again on receipt (`src/sandbox/create-sandbox.ts` near line 433). Thus a traceback at the end of a long output never reaches the host.

The two earlier changes of this series make the history final:

- `keep-each-agent-conversation-append-only` keeps each conversation append-only. A mask limits the tools that run, and each request declares the same tools.
- `save-each-chat-round-and-add-context-on-change` stores each round of a chat turn before the next request, through the round sink `onRound`.

Thus the harness can shorten a result only before its first send. A result of 256 KiB stays in each later request of its conversation.

These facts of the code and the specs constrain the design:

- The loop knows no DBOS and no Postgres (`src/loop/types.ts` line 8). It gets each seam through `RunAgentOptions`.
- `ToolContext` carries no pool and no other injected dependency (harness-tools, "ToolContext carries only request-scoped values"). A tool gets a dependency through its factory closure.
- The usage record key `recordKeyFor` (`run-agent.ts` near line 626) is the same on each replay under a run frame. In a chat turn it is a fresh UUID.
- The data profile uses the literal run id `data-profile` for each analysis (`src/tasks/data-profile.ts` near line 472).
- A step-mode tool runs inside a durable step, thus a replay gives its stored result. A workflow-mode tool runs in the workflow body, thus a replay runs it again over the stored outputs of its own steps.
- The largest skill file of the repository (`skills/microbiome/references/dada2-api.md`) gives a `skill_read` result of about 29,300 characters.

## Goals / Non-Goals

**Goals:**

- No tool result longer than the cap joins a transcript.
- The model can read each part of a long result again, by an offset or by a pattern.
- The end of a long command output reaches the host and the model.
- The loop does not know the storage, and each tool gets the cut with no change of its code.

**Non-Goals:**

- Compaction. A later change does it.
- A cut of the history that a thread stored before this change. That history is final.
- New bounds for other tools. `read_file` keeps its bound of 256 KiB, and `grep` keeps its bounds.
- A view of a kept text in the display of a host.
- A change of the code of the sandbox server.

## Decisions

### The loop cuts a long result in dispatchTool

`dispatchTool` is the one function that makes the result of a dispatched call. Both dispatch paths reach it: the normal round and the round that a truncation cut. Each segment of a conversation reaches it too: the task, a continuation, and a salvage. Thus the loop does the cut there, and no tool carries its own code for it.

A refusal of the mask, a truncated call, and a not-run answer are short constants of the loop. They do not reach `dispatchTool`.

The loop measures the text that the model reads:

- The text of a `json` or an `error-json` result is the JSON text of its value.
- The text of a `text` or an `error-text` result is its value.
- The text of a `content` result is its text part. The file parts are pictures, and they keep their placement.

A denial result is never cut. It ends the turn, and its text holds the words of the user.

The unit of a length is the UTF-16 code unit, the unit of a JavaScript string length. This document calls it a character. The offsets of `read_tool_output` use the same unit, thus the numbers of an excerpt and the numbers of a read agree.

After the cut, a `json` or a `text` result becomes a `text` result, because a part of a JSON text is not valid JSON. An `error-text` or an `error-json` result becomes an `error-text` result. A `content` result keeps its file parts after the excerpt. The outcome of `tool-finished` does not change.

For a step-mode tool, `dispatchTool` runs inside the durable step of the call. Thus the step output holds the excerpt and not the full text, and a replay gives the same excerpt. For a workflow-mode tool or an inline tool, the cut runs in the body. A replay then runs the tool again over its stored steps, and the cut gives the same excerpt again.

The loop strips NUL from each result before the cut (`jsonValue` and `errorResult`). Thus a kept text holds no NUL, and Postgres accepts it.

This design rejects a bound in each tool. A bound in each tool leaves the next tool without one, and the bounds of two tools can disagree.

### The cap is 32,768 characters

`TOOL_RESULT_CAP` in `src/loop/tool-output.ts` is 32,768 characters. These are the reasons:

- Each skill read stays whole, because the largest skill file gives about 29,300 characters.
- The model reads command results of about this length today, because the current bound of each stream is 32 KiB.
- The cap is about 8,000 to 11,000 tokens. Thus one result stays a small part of the context window, and some reads do not fill the transcript of a long step.

A `read_file` result of 256 KiB is 8 times the cap. The loop cuts it. The model then reads the rest through the reference, or it reads a window with `headLines` or `tailLines`.

### The excerpt shows the start, the end, and the lengths

The excerpt holds these parts, in this order. The example is a result of 482,113 characters that the loop kept:

```text
[Tool result cut: 482113 characters, over the limit of 32768. Shown: the first 4096 and the last 8192 characters.]
[The harness kept 482113 characters as reference "to_3f9a2c41b8d605e7a1c0". Call read_tool_output with this reference and an offset and a limit, or with a pattern. Offsets start at 0.]
<the first 4096 characters of the text>
[... 469825 characters not shown ...]
<the last 8192 characters of the text>
```

With no kept text, the first line ends with `The rest is not kept.`, and the excerpt has no second line.

The start is 4,096 characters, and the end is 8,192 characters. These are the reasons:

- The start holds the shape of a result: the status and the first keys of a JSON result, the exit code of a command, and the header row of a table.
- The end holds the errors: a traceback, an R error, and the last lines of a log. JSON puts the stream flags and the totals of `execute_command` last, thus they are in the end too. Thus the end gets two times the length of the start.
- An excerpt with its lines has about 12,800 characters, less than half the cap. Thus a cut saves at least 60% of a result that is just above the cap.

The first line comes before the content. Thus the model reads that the result is an excerpt before it reads the text. The second line names `read_tool_output` only when the loop kept the text.

A cut point never splits a surrogate pair. When a point falls between the two halves of a pair, the loop moves the point by one unit, thus the pair stays whole.

### The tool output store and the kept text

`src/loop/tool-output.ts` holds the interface of the store:

```ts
export interface KeptToolOutput {
    readonly analysisId: string;
    readonly ref: string;
    readonly toolName: string;
    readonly toolCallId: string;
    /** The thread of a chat loop. Absent for a loop of a run. */
    readonly threadId?: string;
    /** The kept text: the whole text, or its start and its end with a marker line between them. */
    readonly content: string;
    /** The length of the whole text of the result. */
    readonly totalLength: number;
}

export interface ToolOutputStore {
    /** Keep one text. A second put of the same analysis and reference replaces the text. */
    put(output: KeptToolOutput): ResultAsync<void, DomainError>;
    /** The kept text of one reference in one analysis, or null. */
    get(analysisId: string, ref: string): ResultAsync<KeptToolOutput | null, DomainError>;
}
```

`RunAgentOptions.toolOutputStore` carries the store, the same way as `usageRecorder`. The loop knows only the interface. The error type is `DomainError`, thus the loop reads no shape of a storage error.

The loop keeps a text only when two conditions are true: the run has a store, and the agent declares `read_tool_output`. Without the tool, no request of the conversation can read the text, and the reference names a tool that the model does not have. Thus the loop then keeps nothing, and the excerpt states that the rest is not kept.

A text of at most `TOOL_OUTPUT_KEEP_MAX` characters, 1,048,576, stays whole in the store. A longer text keeps its first 524,288 and its last 524,288 characters, with a marker line between them. The marker line gives the count of the characters that the store does not keep. These are the reasons for the maximum:

- It is the bound of a file that `grep` reads (`MAX_GREP_FILE_BYTES`, `src/tools/workspace/grep.ts` line 23). Thus a pattern search over a kept text costs no more than a `grep` of a file.
- It keeps each `read_file` result whole.
- It bounds the memory of the sandbox server, which holds each finished result for one hour. Refer to Risks.
- A model reads a kept text in pages of at most 16,384 characters, or through a pattern. 1 MiB is 64 pages, and a task does not read more.

The loop awaits the `put` before the result joins the transcript. Thus the store holds the text before a request sends the reference, and before the round sink gets the round.

The excerpt does not depend on the outcome of the `put`. Thus the excerpt is a function of the text, the reference, and the two conditions, and a replay gives the same bytes. When the `put` fails, the loop logs one warn, and the run continues. A read of that reference then gives `not_found`.

### The key and the reference

The key of a kept text is `recordKeyFor(session, opts.invocationId, stepName)`. `stepName` is the tool step name of the call, and that name holds the tool call id, for example `tool:read_file:toolu_01`. Thus the key follows the key of a usage record, and it names the tool call id. Under a run frame the key is the same on each replay. In a chat turn it is a fresh UUID, because a chat turn has no replay.

The reference is `to_` and the first 20 hexadecimal characters of the SHA-256 hash of the key, for example `to_3f9a2c41b8d605e7a1c0`. The model copies the reference, thus it is short. With 80 bits, a collision in one analysis is improbable.

The analysis id is part of the identity of a row. The data profile uses the same literal run id and step id for each analysis. Thus two analyses can make the same key, and only the analysis id keeps their rows apart.

A `put` is an upsert on the analysis id and the reference, and a second `put` replaces the text. A replay of a workflow-mode tool writes the same text again, and the row does not change. The first `put` of a key sets `created_at`, and a replacement keeps it.

### The thread of a kept text

The loop sets `threadId` from `session.scope.threadId` only when the session has no run frame. Thus each text of a chat turn names its thread, and so does each text of a sub-agent in that turn. A report turn names its report thread.

A run session carries the scope of the chat that started the run (`src/tools/execute-analysis.ts` near line 462). Thus without the rule, a text of a run would name that chat thread. A run belongs to the analysis, and not to the thread that started it. Thus a text of a run names no thread, and only the analysis purge removes it.

`purgeThread` deletes the kept texts of each thread that it removes. Thus a removed thread leaves no conversation data behind. The key and the reference do not change, because the thread id is not a part of the identity of a row.

### The table cortex_tool_outputs

```sql
CREATE TABLE IF NOT EXISTS cortex_tool_outputs (
  analysis_id  TEXT NOT NULL,
  ref          TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  thread_id    TEXT,
  content      TEXT NOT NULL,
  total_length INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (analysis_id, ref)
);
CREATE INDEX IF NOT EXISTS cortex_tool_outputs_thread_idx
  ON cortex_tool_outputs (thread_id) WHERE thread_id IS NOT NULL;
```

`initCortexState` makes the table and the index. The comment block of the DDL holds no semicolon, because the init divides the DDL at each semicolon. The partial index serves the delete of a thread purge, and a row of a run stays out of it.

`createToolOutputStore(pool)` in `src/state/tool-outputs.ts` realizes the interface with `tryMutation` and `tryQuery`. `get` reads one row by the analysis id and the reference, and it gives `null` for no row.

`purgeAnalysis` deletes the rows by `analysis_id`, in its list of the analysis-keyed tables. Thus it removes the texts of each thread and of each run of the analysis.

`purgeThread` deletes the rows whose `thread_id` is in its subtree, with the subtree walk of its other deletes. The delete runs in the transaction of the purge, before the delete of the thread rows, because the walk reads those rows.

The table is in the database and not in files. A tool result is conversation data, the same as the rows of `messages`. Files stay for the products of an analysis. Thus the purge of an analysis removes a kept text with the other conversation data of that analysis.

### The tool read_tool_output

`createReadToolOutputTool(store)` in `src/tools/read-tool-output.ts` makes the tool. The factory captures the store, thus `ToolContext` carries no store and no pool. The tool runs in the `step` mode, thus a durable replay gives its stored result.

The input has these fields:

- `ref`: the reference of the excerpt.
- `offset`: the index of the first character of the window, from 0. The default is 0.
- `limit`: the count of characters of the window. The maximum is 16,384.
- `pattern`: an optional JavaScript regular expression.

The tool reads the row of `ref` in the analysis of `ctx.session.scope`. A reference of a different analysis gives `not_found`. Thus a reference in a tool result or in a web page cannot reach a different analysis.

Without a pattern, the tool gives the window of the kept text. The default limit is 8,192. With a pattern, the tool searches the window. The window then reaches the end of the kept text when the call gives no limit.

The tool compiles the pattern with the flag `g`, and it gives at most 20 matches. Each match gives its offset and a text: up to 150 characters before the match and up to 250 characters from its start. A match of zero length moves the search on by one character.

```ts
type ReadToolOutputResult =
    | { status: "ok"; ref: string; offset: number; end: number; keptLength: number; more: boolean; text: string }
    | { status: "matches"; ref: string; pattern: string; offset: number; end: number; keptLength: number; more: boolean; matches: { offset: number; text: string }[] }
    | { status: "no_matches"; ref: string; pattern: string; offset: number; end: number }
    | { status: "not_found"; ref: string }
    | { status: "out_of_range"; ref: string; offset: number; keptLength: number }
    | { status: "invalid_pattern"; pattern: string; error: string };
```

`end` is the offset where the tool stopped. When `more` is true, the next call continues at `end`.

The JSON text of each result stays under the cap. The loop JSON-escapes the text of a page, and an escape can make a text two times longer. A control character becomes six characters. Thus the tool measures its result, and it shortens the text or drops the last matches until the result has at most `TOOL_RESULT_CAP` minus 512 characters. `end` then gives the true stop. Thus the loop never cuts a result of `read_tool_output`.

This design rejects a virtual path that `read_file` resolves. The workspace resolves a real path with `realpath` and `O_NOFOLLOW` (`src/workspace/filesystem.ts` near lines 173 and 358), thus a virtual path needs a second resolver in that seam. A sandbox agent would also try the path in `execute_command`, and the sandbox has only its mounts.

### Each agent with a tool declares read_tool_output

These agents declare the tool from their first request:

- the conversation agent, after `grep`
- the report agent, after `grep`
- each sandbox agent and the data profiler, through the substrate, after the workspace tools
- the planner of `generate_plan`, after its search tools and before its terminal tools
- the analogical reasoner of `generate_analogy_report`, after its search tools
- the literature reviewer, after its bio-lookup tools
- the run synthesizer, after `literature_reviewer`

Each of these agents gets the store through its deps. A loop-driving tool gives the same store to the read tool of its sub-agent and to the `RunAgentOptions` of the loop of that sub-agent.

The file-metadata continuation and the summary continuation mask the other tools. A `read_file` result in those continuations can be longer than the cap. Thus both masks also let `read_tool_output` run. A mask does not change the prefix of a request, and the tool is a declared tool of the step agent. The salvage mask and the wrap-up mask do not change. A terminal tool gives a short result, and the wrap-up runs no tool.

The literature reviewer and the run synthesizer have tool lists that the `literature-reviewer` spec names as exact. The delta adds `read_tool_output` to both lists. The spec list of the reviewer names tools that the code no longer holds. Thus the modified scenario names the `reviewerTools` const, the source of the list. The code of the synthesizer also declares `validate_synthesis`, thus the modified list names it.

This design rejects a rule in the loop that lets `read_tool_output` pass each mask. A mask then no longer names each tool that can run.

### The composition gives one store to each loop

`assembleCoreRuntime` makes one store, `createToolOutputStore(conversation.pool)`. It gives the store to the conversation agent, the report agent, the sandbox step, `executeAnalysis`, and the data profile. `CoreWorkflowDeps` and `ConversationAssemblyDeps` omit the field, the same as `usageRecorder`. Thus an embedder cannot wire a store that only a part of the agent tree uses.

The sandbox step gives the store to `SandboxAgentBuildContext` and to each loop that it runs: the task and the two post-step continuations. It logs one warn when it has a store and the agent of `buildAgent` has no `read_tool_output`. Thus an embedder that does not give the store to its agents sees the gap.

`runChatTurn` gives the root loop a store over the pool of its deps. `prepareChatTurn` makes the thread history and the working memory over that pool in the same way. The realization holds no state apart from the table, thus two instances over one pool read and write the same rows.

`src/index.ts` exports the types `ToolOutputStore` and `KeptToolOutput`. `RunAgentOptions` and `SandboxAgentBuildContext` name them. The rule of the `harness-embedder-exports` capability puts each field type of an exported dependency object in the root barrel.

### The sandbox gets a stream budget of 1 MiB

`EXEC_STREAM_BYTE_CAP` becomes `TOOL_OUTPUT_KEEP_MAX`, 1,048,576. `submitExec` sends it as `stdoutByteCap` and `stderrByteCap`. The client cuts each stream at it on receipt, with `capExecStreams`, and `boundExecResult` bounds the streams of `execute_command` at it. Thus the host gets each stream that the store can keep, and the loop decides what the model sees.

The code of the server does not change. The server keeps the start of each stream up to the budget, counts the rest, and sets the truncation flag and the total (`executor.go` near line 544). The Go tests of `capturingBuilder` hold that behavior.

The `sandbox-server` delta states the budget in the completion payload, because the spec text names the full stream. The modified text also names `usage`, which the payload already carries.

The description of `execute_command` states the budget of 1 MiB for each stream. It also states that a long result comes back as an excerpt with a reference. It keeps the text that stdout and stderr are not a deliverable.

A stream longer than 1 MiB still loses its end in the sandbox. Most commands write a traceback to stderr. Thus the end of a short stderr stays in the result when stdout is long.

## Risks / Trade-offs

- [The durable checkpoint of a command grows] → The poll step stores the raw result body, and the body can now hold two streams of 1 MiB. Most commands write little. The analysis purge removes the checkpoints with the workflow footprint.
- [The sandbox server holds more memory] → The server keeps each finished result for one hour, as `Result` and as `CompletionBody` (`exectable.go`). A command with two full streams holds about 4 MiB. A step that runs many such commands in one hour can hold hundreds of MiB. A later change can release the `Result` copy.
- [A callback ingress refuses a large completion] → In callback mode, the completion POST can carry 2 MiB. An ingress with a smaller body limit refuses it. The recovery pull of `awaitExec` then gets the result from the exec endpoint.
- [The model reads the excerpt as the whole result] → The first line states the cut and the lengths before the text.
- [A put fails] → The reference then has no row, and `read_tool_output` gives `not_found`. The loop logs a warn with the tool name and the reference.
- [A pattern of the model is slow] → The pattern runs in the process, the same as the pattern of `grep`. A kept text has at most 1,048,576 characters, the bound of a file that `grep` reads.
- [A local model gives a tool call id again] → Two profile runs of one analysis can then make one key. The later text then replaces the earlier text. The earlier profile run is finished, thus no request reads its text.
- [The kept texts grow with an analysis] → The analysis purge removes them, and a thread purge removes the texts of its threads.
- [A turn keeps a text after the purge of its thread] → The row then names a thread that does not exist. The analysis purge still removes it, because the row has its own analysis id. A host stops the writes to a thread before it purges the thread, as the thread store requires.
- [A replayed passthrough loop keeps new texts] → The run synthesis runs its loop with `passthroughStep` in the workflow body. A replay makes new calls with new tool call ids, thus new rows. The earlier rows stay until the analysis purge.
- [The deltas build on changes that are not archived] → Three deltas modify the text of `keep-each-agent-conversation-append-only`: `harness-sandbox-agents`, `per-agent-tool-allowlist`, and `step-interpretation-summary`. The `analysis-purge` delta and the `harness-thread-store` delta modify the text of `save-each-chat-round-and-add-context-on-change`. Archive those changes first.

## Migration Plan

The state initialization makes `cortex_tool_outputs` with `CREATE TABLE IF NOT EXISTS`. No backfill runs. A stored thread keeps its results with no change, because its history is final.

A host drains the workflows of the earlier version before it runs this version, as for each release. DBOS recovers a workflow under its own application version. A workflow that replays across the two versions can cut a result that the earlier version sent whole.

The CLI gives the store to its sandbox agents in this change. Cortex gives it when it bumps the pin. Until then, the sandbox agents of Cortex keep no text, and each excerpt of those agents states that the rest is not kept.

A delta cannot change the Purpose of a spec. When this change archives, write the paragraph on the thin ledgers in the Purpose of `postgres-storage-backend` again. The kept text of a cut tool result is conversation data in `cortex_tool_outputs`, the same as the rows of `messages`.

## Open Questions

None. The owner decided the question of the thread purge. A text of a chat thread names its thread in a nullable `thread_id` column, and `purgeThread` deletes the texts of each thread that it removes.
