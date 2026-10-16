# Proposal

## Why

GitHub issue #678: the host serves the transcript of a session with one read of the whole thread. The display read `loadAll` selects and parses each row of the thread (`src/memory/thread-history.ts:603-680`). Thus the work of a transcript read grows with the session, with no bound, and a web client cannot bound the size of a page.

The `harness-thread-history` spec says that the display read has no paginated form (`openspec/specs/harness-thread-history/spec.md:34-48`). The reason is that a page of that read would still select and parse each row. A keyed read removes that reason: it finds the openings of the newest turns from the primary key `(thread_id, seq)` of `messages`, and it reads only the rows of those turns.

The harness is the product core. Thus the paged read comes first in the harness, and the cli connects it in a companion change with the same name.

## What Changes

- A new display read of `ThreadHistory`: one page of whole turns, newest first. The caller gives a limit of turns and, for an older page, the cursor of the page before. The read gives the turns of the page oldest-first, and the cursor of the next older page, or `null` at the start of the thread.
- The read selects and parses only the rows of the turns of the page. Each row carries the same fields that `loadAll` gives for it.
- `loadAll` stays. The cli heal of a failed retract reads the tail turn with it.
- The package root exports the new read types.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-thread-history`: the requirement "A display read backs the messages endpoint" gets the paged form, and it drops the statement that the display read has no paginated form.

## Impact

- harness code: `src/memory/thread-history.ts`, `src/index.ts`, and the `ThreadHistory` fakes in `src/app/message-assembly.test.ts`.
- harness tests: `src/memory/thread-history.test.ts`, against the Postgres of the test suite.
- No migration. The primary key `(thread_id, seq)` of `messages` and the primary key `(thread_id, start_seq)` of `cortex_thread_turns` serve the read.
- The companion cli change uses the read, and it updates the `ThreadHistory` fake in `cli/src/modules/harness/turn.test.ts`.
