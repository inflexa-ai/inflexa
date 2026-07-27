# Horrible Bug Fixes

Postmortems of catastrophic bugs: what broke, the actual root cause, and the lesson that prevents recurrence. Read the relevant entry before working in the same area (see `CLAUDE.md`).

Entry format:

```markdown
## <n>. <Title> (<YYYY-MM-DD>)

**Symptom:** what the user saw.
**Root cause:** the actual mechanism, not the proximate trigger.
**Fix:** what changed.
**Lesson:** the rule that prevents recurrence.
```

---

## 1. Solid `<For>` inside an opentui `<scrollbox>` silently dropped rows on `@opentui/core` 0.4.0 (2026-07-02)

**Symptom:** In a fuzzy-filtered list rendered with `<For>` inside a `<scrollbox>`, typing a filter character and then deleting it lost rows: the restored entries never reappeared, with console warnings like `Anchor with id <id> does not exist within the parent scroll-box-content, skipping insertBefore`.

**Root cause:** `<For>` keys children by item reference. When a filtered array shrinks and then grows back with the *same* item references, Solid reuses the surviving nodes and re-inserts the restored ones via `insertBefore(node, anchor)` against an existing child as the anchor. On `@opentui/core` 0.4.0, that anchor lookup failed inside the scrollbox's content renderable, and `Renderable.insertBefore` handles a missing anchor by **warning and returning -1 without inserting** — the row is silently discarded, not errored. Code that regenerates wrapper objects every keystroke (fresh references → full teardown/re-mount, append-only) never exercises this path, which is why the same version could look "fine" in one list and broken in another.

**Fix:** The `@opentui/core` 0.4.0 → 0.4.2 bump. Verified on 0.4.2 with the `testRender`/`captureCharFrame` harness across the shapes a real list produces: shrink-then-grow with stable refs, reordered subsets, full-set scrambles, and grouped `[category, items[]]` tuples rendering fragments with nested `<For>` — all rows correct, zero warnings.

**Lesson:** `<For>`'s reuse path (stable references being moved/re-inserted) is a *different* renderer code path from the naive recreate-everything path, and opentui's `insertBefore` fails **silently** (warn + skip, no throw). When bumping `@opentui/*`, re-verify the reuse path with a shrink-then-grow + reorder repro before trusting `<For>` inside `<scrollbox>`; if it regresses, `<Index>` (position-keyed, never re-inserts before an existing anchor) is the escape hatch.

---

## 2. macOS Terminal.app ⌘K left the chat permanently blank (2026-07-27)

**Symptom:** Running `inflexa` in Terminal.app and pressing ⌘K — an easy mis-keypress, since the command palette is `ctrl+k` — blanked the entire UI. It stayed blank through further rendering; scrolling the terminal back up showed the old frame, so the app looked like it had "navigated" somewhere.

**Root cause:** Two independent facts meeting. (1) Terminal.app's ⌘K is **"Clear to Start"** (the `clearAll:` menu action — *not* "Clear Scrollback", which is a separate item), which scrolls the visible screen into scrollback and leaves a blank viewport. It applies this to the alternate screen too, and being a menu action it sends the app no bytes, no `SIGWINCH`, and no focus change — there is **no signal the app can react to**. (2) OpenTUI renders **diffs**: each frame it compares against a shadow buffer of what it believes is on screen and writes only changed cells. Verified in a pty on 0.4.2 — a re-render with unchanged content emits **zero bytes**. So after the wipe every surviving cell was "already correct" and was never rewritten. The app was rendering correctly the whole time, into a screen the terminal had emptied; only cells that happened to change afterwards appeared, which is why a lone scrollbar pip showed on the blank screen.

**Fix:** `src/tui/hooks/repaint.ts`. `forceFullRepaint` invalidates the shadow buffer so the next frame rewrites every cell (~13 KB at 200x50, wrapped in synchronized output, stays in the alternate screen). It is reached by two paths: an explicit `app.redraw` key (`ctrl+l`, the universal terminal redraw convention) on a **mode-less** layer so it survives an open modal, and `watchScreenDamage`, which forces one repaint on the first keystroke after ≥500 ms of keyboard idle — so a user who knows nothing about redraw keys just presses something and the UI returns, while a typing burst never crosses the gap and costs nothing.

**Lesson:** With a diff renderer, **anything that changes the screen without going through the renderer is invisible and permanent** — the shadow buffer is now lying and no amount of re-rendering repairs it. Terminals offer no damage notification, so recovery has to be user-triggered; assume any full-screen TUI needs a force-repaint path. Note `forceFullRepaintRequested` is **private** in `@opentui/core` (checked in 0.4.2 and 0.4.5 — there is no public repaint/redraw method), so the fix writes a private field, and `repaint.render.test.tsx` asserts the field still exists on a real renderer; an upgrade that renames it fails the suite instead of silently reverting the fix to a no-op. The two public alternatives were measured and rejected: `suspend()`+`resume()` leaves and re-enters the alternate screen (flash, and on Terminal.app re-causes the symptom), and jiggling `resize()` relayouts the tree at a wrong size for a pass and emits spurious `resized` events.
