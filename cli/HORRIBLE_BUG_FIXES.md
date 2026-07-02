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
