# Design

## Context

`src/lib/log.ts` builds one `pino.destination` at module load (`log.ts:78`).
The file name comes from `rotatedLogFile()` (`log.ts:19-43`): a retention
sweep, then `new Date().toISOString().slice(0, 10)` (`log.ts:33`), then a
scan for a numbered sibling when the file of the day is at or above 20 MB.
The destination opens from a numeric fd that `openSync(file, "a")` gives
(`log.ts:68`). Commit `f60e1e66` chose the fd on purpose. A `SonicBoom` that
gets a number has a valid fd from its constructor. Thus the exit hook of pino
and `flushLogsSync` (`log.ts:168-174`) never see an unopened stream.

The design record of `2026-06-12-add-pino-otel` deferred an in-flight roll
(D8, "revisit if real logs prove otherwise"), and it never named a calendar.
The spec `structured-logging` says "at logger initialization" and no timezone.

The reader of the file is a person. The `--help` text (`src/lib/env.ts:515`)
says "rotated daily". No program in the cli reads the log directory.

The two common libraries were read for this design. `winston-daily-rotate-file`
passes `utc: false` to `file-stream-rotator` by default, and that library
compares a formatted date on each write. `pino-roll` has no UTC option, it
arms one `setTimeout` to the next local midnight with `.unref()`, and on fire
it calls `destination.flush()` then `destination.reopen(newName)`.

## Goals / Non-Goals

**Goals:**

- The name of the file carries the local calendar date.
- A live process moves to the file of the new day at local midnight, with no
  work on the write path.
- The retention sweep reads the date on the same local calendar.
- The synchronous-open guarantee of `f60e1e66` holds across a roll.
- A test pins the name, the roll, and the retention cutoff.

**Non-Goals:**

- A worker-thread transport. The spec forbids `pino.transport`, and
  `pino-roll` is one. Its mechanism is about thirty lines, and the cli runs
  it in-process.
- A size roll while the process runs. The 20 MB scan runs at startup and at
  each midnight roll, because the roll calls `rotatedLogFile()`. A file that
  grows past 20 MB inside one day keeps its file, as today.
- A `current.log` symlink. Nothing in the repository makes a symlink today,
  and Windows needs a fallback.
- A per-write date compare, which is what `file-stream-rotator` does. The
  timer is enough, and the write path stays as it is.

## Decisions

### D1. The local calendar names the file, and the sweep reads the same calendar

A helper `localDay(date)` renders `YYYY-MM-DD` from `getFullYear`,
`getMonth`, and `getDate`. The retention sweep parses a stamp with
`new Date(year, month - 1, day)`, which is local midnight of that day. A
stamp from the old UTC naming still matches `LOG_FILE_PATTERN`, thus the sweep
removes old UTC-named files on the same schedule.

Alternative: keep UTC and document it. Rejected, because the person who reads
`ls` uses the local date, and both libraries default to local.

### D2. One timer to the next local midnight, then a reopen, then the timer arms again

`msUntilNextLocalMidnight(now)` is `next - now`, where `next` is a copy of
`now` with `setHours(24, 0, 0, 0)`. That call gives local midnight of the next
day, and it obeys a daylight-saving change. The delay fits `setTimeout`.

On fire, the roll calls `rotatedLogFile()` again. That call sweeps retention
and scans the numbered sibling, thus the new day gets the same rules as a
start. If the name is equal to the current name, the roll only arms the timer
again. Otherwise the roll calls `destination.flush(cb)`, and in the callback
`destination.reopen(newName)`. The roll keeps its own current name, seeded
from the file that the start opened, and set on each reopen. Then the timer
arms again from the fire time, not from the planned time. Thus a late fire
after a sleep computes the next boundary correctly.

A flush error or a reopen throw is swallowed. The timer arms again, and the
records continue on the current fd. The spec says that a rotation failure
must not prevent logging, and a throw out of a timer callback would end the
process.

The timer is `unref()`, thus it never keeps a process alive. A laptop asleep
across midnight fires the overdue timer on wake, and a record or two can land
in the old file first. Accepted, the same as `pino-roll`.

### D3. The fd-built stream gets its `file` field, so that `reopen` is legal

`SonicBoom.prototype.reopen` (`node_modules/sonic-boom/index.js:473-511`)
throws "Unable to reopen a file descriptor" when `this.file` is null, and a
stream built from a number has `file = null` (`index.js:116`). The
constructor sets the field only from a path. Thus the cli sets
`destination.file = file` right after `openFileDestination()` builds the
stream. The field is a plain instance property that sonic-boom's own
`fileOpened` writes (`index.js:56`), and `reopen` reads it as its one gate.
The `SonicBoom` type does not declare the field, thus the assignment goes
through a one-line typed cast with that invariant in the comment.

Alternative: build the stream from the path, so that `file` is set from the
start. Rejected, because a path with `sync: false` opens with `fs.open`, and
the fd is -1 until the callback. That is the window that `f60e1e66` closed.

Alternative: build a new destination each day and swap it under a wrapper
stream. Rejected, because it needs a wrapper in `pino.multistream`, an end of
the old stream, and a second exit hook of pino per day.

### D4. Flush before the reopen

`reopen` does not flush. Records buffered before the swap would land in the
file of the new day. `pino-roll` calls `flush(cb)` first for that reason, and
the cli does the same.

### D5. The exit flush holds across a roll

`openFile` (`index.js:23-95`) does not reset `fd` while a reopen is in
flight. The old fd stays until `fileOpened` sets the new one, and then a
`ready` listener closes the old fd. Thus `flushSync` during a reopen writes
the buffers to the old fd, and it never throws "not ready yet". The
guarantee of `f60e1e66` holds at midnight. `flushLogsSync` keeps its
try-catch as a second guard.

### D6. The pure parts are exported, and the module singleton composes them

`localDay`, `msUntilNextLocalMidnight`, and `rotatedLogFile(dir, now)` are
pure over their arguments. `scheduleMidnightRoll(destination, deps)` takes a
minimal `{ flush, reopen }` interface, a `now` function, and a `setTimer`
function. The module singleton calls them with the real values. A test builds
a temp directory, a fake clock, a fake timer, and a fake destination, and it
never touches the singleton. The test can still import `log.ts`, because the
test preload points `XDG_DATA_HOME` at a sandbox.

### D7. The help text names the truth

`envDoc.logDir.description` becomes "one file per local day, 7-day
retention". The docs regenerate from it with `bun run docs:gen`.

## Risks / Trade-offs

- [A person reads the old UTC-named files beside the new local-named files
  for one offset window] → The pattern matches both. The sweep removes the
  old files within 7 days.
- [The `file` cast reaches into a library field] → The invariant is in the
  comment, and `reopen` is the documented rotation entry of sonic-boom. A
  sonic-boom upgrade that renames the field fails the new test at once.
- [A roll fires while the process exits] → D5. The old fd stays valid until
  the new open completes, and `flushLogsSync` swallows a throw.
- [A clock jump backward before midnight] → The roll compares the new name
  with the current name. When they are equal, it only arms the timer again.
- [Two processes on one machine roll at the same instant] → Each one opens
  the same file in append mode. `O_APPEND` keeps the writes intact, and
  each record carries its `pid`. Unchanged from today.
