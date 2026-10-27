# Proposal

## Why

Bun runs each async `node:fs` call as a blocking syscall on one process-wide thread pool, sized by the core count. On a 12-core machine, 12 reads that hang on a network mount block each other async file call of the server: `fs/read`, `fs/list`, the staging, and the logs. The walk of `fs/search` keeps 512 reads in flight, thus one search of a hung mount can stall the whole server. A timer in JavaScript does not free a thread that waits in the kernel.

## What Changes

- The walk of `fs/search` runs in a child process of the server. The server starts it through the self-invocation of the CLI binary, as the detached server and the transfers do. A hung read then traps only the pool threads of the child.
- A new hidden subcommand `inflexa server walk <scope> [--hidden] [--depth <n>] [--width <n>]` is the entry point of the child. It is `standalone`, and its agent policy is `blocked`, because only the local server starts it and it streams a binary protocol on stdout.
- The child walks with the rules of the current walk: `readdir` with the file types, no `stat`, no entry into a symbolic link, the hidden filter, the depth cap, and a skipped unreadable folder. It streams compact binary records to stdout in large buffers. A failed read of the scope itself is a protocol record, thus the route keeps its 404, 400, and 403 answers.
- The server builds the existing name index from the stream, with no string for each entry. It owns each cap: the entry counts, the total, the time budget, the TTL, and the eviction. At a cut, an eviction, or a stop, the server kills the child with `SIGKILL` and does not wait for its exit.
- The count of live walk children is bounded. A walk beyond the bound waits in a queue for a free slot.
- The child exits when the server dies: a write to a closed pipe, or a parent that is gone, ends it.
- Single-flight, the byte scorer, the bounded heap, and the enrichment of the hits stay as they are.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the walk requirement of the search (a child process, the kill rules, the bound on live children), the `server` commands requirement (the hidden `server walk` command, and `standalone` as a permitted kind).
- `agent-cli-tool`: `inflexa server walk` is `blocked` for the agent.

## Impact

- `src/modules/fs/search_index.ts`: the in-process walk becomes a reader of the record stream of a child, with an injectable spawner.
- `src/modules/fs/walk_child.ts` (new): the walk of the child and the record protocol, shared by the command and by the tests.
- `src/cli/index.ts`: the hidden `server walk` command. `src/cli/agent_policy_tree.test.ts` records it.
- `src/server/routes/fs.ts`: the search route maps a failed spawn to 500.
- No new dependency. No TUI change.
