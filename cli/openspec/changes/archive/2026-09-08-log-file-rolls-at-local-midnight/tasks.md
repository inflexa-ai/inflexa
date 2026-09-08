## 1. The pure parts of the file name

- [x] 1.1 In `src/lib/log.ts`, add `localDay(date: Date): string`, which renders `YYYY-MM-DD` from the local `getFullYear`, `getMonth`, and `getDate`. Export it.
- [x] 1.2 In the same file, add `msUntilNextLocalMidnight(now: Date): number`, which copies `now`, calls `setHours(24, 0, 0, 0)` on the copy, and returns the difference. Export it.
- [x] 1.3 In the same file, change `rotatedLogFile` to take `(dir: string, now: Date)`. Use `localDay(now)` for the stamp. Export it.
- [x] 1.4 In the same function, parse the stamp of the retention sweep with `new Date(year, month - 1, day)`, so that the cutoff reads the local calendar.
- [x] 1.5 In `openFileDestination`, call `rotatedLogFile(env.logDir, new Date())`, and return the path beside the stream, so that the roll starts from it.

## 2. The roll at local midnight

- [x] 2.1 In `src/lib/log.ts`, add a minimal interface `RollableDestination` with `flush(cb: (err?: Error) => void): void` and `reopen(file: string): void`.
- [x] 2.2 In the same file, add `scheduleMidnightRoll(destination, deps)`, where `deps` carries `dir`, `currentFile`, `now: () => Date`, and `setTimer: (fn, ms) => void`. The function keeps its own `current` variable, seeded from `deps.currentFile`. On fire, the function computes the new name with `rotatedLogFile(deps.dir, deps.now())`. When the name is equal to `current`, the function arms the timer again. Otherwise it calls `destination.flush`, then `destination.reopen(newName)` in the callback, then it sets `current`, then it arms the timer again from the fire time. A flush error or a reopen throw is swallowed, and the timer arms again. Export it.
- [x] 2.3 In `openFileDestination`, after the fd-built stream is made, set its `file` field to the path through a one-line typed cast. Put the invariant of design D3 in the comment: sonic-boom's `reopen` reads `file` as its one gate, and its own `fileOpened` writes the same field.
- [x] 2.4 In the module body, call `scheduleMidnightRoll(fileDestination, ...)` with `env.logDir`, the file that was opened, `() => new Date()`, and a `setTimer` that calls `setTimeout(fn, ms).unref()`.
- [x] 2.5 Replace the comment at the top of `rotatedLogFile`, which says that a session across midnight keeps its file. State the new rule: the sweep and the scan run at startup and at each midnight roll.

## 3. The help text

- [x] 3.1 In `src/lib/env.ts`, change the `logDir` description in `envDoc` to "one file per local day, 7-day retention".

## 4. The tests

- [x] 4.1 Add `src/lib/log.test.ts`. Use a temp directory per test, the same as `src/lib/download.test.ts`.
- [x] 4.2 In that file, assert that `localDay` renders the local date, with a `Date` built from local components.
- [x] 4.3 In the same file, assert that `msUntilNextLocalMidnight` gives the distance to the next local midnight. Use a time before midnight and a time at 00:00:00.
- [x] 4.4 In the same file, assert that `rotatedLogFile(dir, now)` names the file by the local day. Assert that it moves to the numbered sibling when the file of the day is at or above 20 MB.
- [x] 4.5 In the same file, assert that the retention sweep of `rotatedLogFile` removes a file stamped 8 days back on the local calendar. Assert that it keeps a file stamped 6 days back.
- [x] 4.6 In the same file, drive `scheduleMidnightRoll` with a fake clock, a fake timer, and a fake destination that records `flush` and `reopen`. The fake `setTimer` captures `fn` and `ms`, and the test calls `fn()` to fire. Assert that the fire at midnight flushes, then reopens on the name of the new day, and then arms the timer again. Assert that a fire with an equal name only arms the timer again. Assert that a reopen throw leaves the timer armed.

## 5. Verification

- [x] 5.1 Run `bun run typecheck` in `cli/`.
- [x] 5.2 Run `bun test src/lib/log.test.ts` in `cli/`. Do not run the full suite.
- [x] 5.3 Run `bun run format:file src/lib/log.ts src/lib/env.ts src/lib/log.test.ts` in `cli/`.
- [x] 5.4 Run `openspec validate log-file-rolls-at-local-midnight --strict` in `cli/`.
