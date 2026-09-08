# The log file rolls at local midnight, and its name carries the local date

## Why

Issue #506 asks whether a session that runs across midnight writes into the
wrong log file. It does, in two ways. The name of the file comes from the UTC
date, computed one time at module load (`src/lib/log.ts:33`). And one
destination stays open for the life of the process (`src/lib/log.ts:78`).
Thus a TUI session that starts at 23:50 writes its 02:00 records into the
file of the day before. And at UTC+03:00 a process that starts before 03:00
local stamps the day before, thus `inflexa-<today>.log` can be absent while a
session is live. The `--help` text says "rotated daily", and a person reads
that as the local day.

The file name is for a person on that machine. The two common libraries agree:
`winston-daily-rotate-file` defaults to `utc: false`, and `pino-roll` has no
UTC option at all. Both roll the file in-process while the process lives.

## What Changes

- The name of the log file carries the local calendar date, not the UTC date.
  The `time` field of each record stays epoch milliseconds.
- A live process moves to the file of the new day at local midnight. A timer
  fires at the next local midnight, the destination reopens on the new name,
  and the timer arms again. No check runs on the write path, and no
  worker-thread transport is used. This is the mechanism of `pino-roll`, run
  in-process on the `SonicBoom` that the cli already holds.
- The retention sweep parses the date in a file name on the same local
  calendar. Today `Date.parse("YYYY-MM-DD")` reads UTC midnight.
- The retention sweep also runs at each midnight roll, because the roll calls
  the same function that names the file.
- The `--help` text for the log directory states the truth: one file per local
  day, 7-day retention.
- A new test file `src/lib/log.test.ts` pins the name, the midnight roll, and
  the retention cutoff. No test covers `src/lib/log.ts` today.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `structured-logging`: the requirement "Log rotation and retention" names the
  local calendar, and it makes a live process move to the file of the new day
  at local midnight. The retention sweep and the size roll stay.

## Impact

- `src/lib/log.ts`: the date stamp, the retention parse, the midnight timer,
  and the reopen of the destination. The pure parts become exported
  functions, so that a test can drive them with a clock and a directory.
- `src/lib/env.ts`: the description text of `logDir` in `envDoc`.
- `src/lib/log.test.ts`: new.
- `openspec/specs/structured-logging/spec.md`: the delta below.
- No new dependency. `sonic-boom` 4.2.1 ships `reopen(file)` already.
- `dist-docs/environment.md` is generated and untracked. Nothing to change by
  hand.
