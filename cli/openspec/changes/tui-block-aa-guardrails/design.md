## Context

opentui's `TextBuffer` seeds `_defaultFg` from `_defaultOptions = { fg: RGBA.fromValues(1,1,1,1) }` and applies it whenever a renderable is constructed without an `fg` option. The emphasis wrappers in `emphasis.tsx` emit `<b>`/`<i>`/`<u>` and a `{ dim: true }` span — none of which carry a color — so `<Bold>{title}</Bold>` inside an `fg`-less `<text>` inherits that white. Verified by span capture on `github-light`: the three reported block titles and five of six gallery type-scale specimens all resolve `#ffffff` against a `#ffffff` surface.

Two rules in the existing specs already forbid this defect *in their own scope*: `theme-system` requires the syntax style register a `"default"` scope so un-captured markdown spans cannot fall through to `#FFFFFF`, and `tui-stream-blocks` requires every **embedded** renderable (`<code>`, `<diff>`, `<markdown>`) receive themed colors. Neither reaches a block's own `<text>`, which is where all eight live sites are.

The reason it recurred is that no test layer can see it. `design_system.contrast.test.ts` measures *declared palette tokens* against backgrounds — text carrying no token is invisible to it by construction. Every `*.render.test.tsx` asserts through `captureCharFrame()`, which returns characters with no color; `openable_card_block.render.test.tsx` passes today partly because its fixture uses the same string for the card title and the row name, so the assertion is satisfied by the row even when the title is unpainted. Only `theme_contrast.render.test.tsx` inspects resolved span colors, and it hand-enumerates two components.

Constraint from `cli/CLAUDE.md`: colors only via `theme()`, glyphs only via `GLYPHS`, no new dependencies, no `.forEach`, `Result` as the error channel, and the design gallery is the single source of truth for TUI surfaces.

## Goals / Non-Goals

**Goals:**

- Make "every rendered text span resolves an explicit theme foreground" a stated, enforced invariant rather than a convention that three components silently broke.
- Close the observability gap with a guard that measures what actually reached the screen, at the correct tier for each span.
- Fix the eight live sites and the test blind spot that concealed one of them.
- Give the approval prompt a marker that reads as a block marker, and give the ask one marker vocabulary across its two surfaces.
- Replace the openable card's incoherent marker column with one that carries a single, legible meaning.

**Non-Goals:**

- Retuning any palette value. Every token in the matrix already passes; this change is about text that carries *no* token.
- Changing the harness contract. `icon` never crosses a wire.
- Auditing non-TUI surfaces (the REPL printer, generated docs).
- Reworking the selection-highlight path (`applySelectionColors`), which is correct and separately specified.

## Decisions

### D1 — The guard measures rendered spans, not palette pairs, and is additive to the matrix

`design_system.contrast.test.ts` stays exactly as it is. It answers "is this palette internally sound?" — a question about declared data. The new guard answers "did every span that reached the screen resolve a readable color?" — a question about rendering. The defect class here is precisely the one the first question cannot express, because the offending text has no token to enumerate.

*Alternative rejected:* extending the palette matrix with a `#ffffff` row. It would not help — the matrix enumerates pairs a component *declares*, and the bug is a component declaring nothing.

### D2 — A span's tier is derived from its content, not from a per-component allowlist

The guard must apply 4.5:1 to text and 3:1 to non-text decoration, because the design system deliberately holds `border` and `fgSubtle` to the lower floor. A naive uniform 4.5:1 sweep flags `ToolBlock`'s frame glyphs (`#8a9097` on `#f6f8fa` = 3.03:1) and `RunBlock`'s meter cells (`#858d97` on `#ffffff` = 3.36:1) — both correct under the existing rules.

The guard therefore classifies mechanically: **a span whose trimmed text consists solely of characters drawn from the design system's decorative set — the box-drawing glyphs, `bar`, and `middot` — is measured at 3:1; every other span at 4.5:1.** The decorative set is derived from `GLYPHS` itself, so it cannot drift from the vocabulary it describes. This matches the empirical result exactly: in a sweep of `PlanCardBlock`, `RunCardBlock`, `ThinkingBlock`, `ErrorBlock`, `ToolBlock`, `RunBlock` and `Welcome`, the only sub-4.5:1 spans were pure ornament and the only sub-3:1 spans were the regressed titles.

*Alternative rejected:* per-component declarations of which spans are decorative. That reintroduces exactly the hand-maintained enumeration whose staleness caused the regression, and a component author who forgets a color is equally likely to forget a declaration.

### D3 — Guard coverage is bound to the gallery's block set and to a same-change rule

Some enumeration is unavoidable: a guard must construct each block with props. To stop that list going stale, the guard is driven from the block set the design gallery already exhibits, reusing `design_gallery_fixtures.ts` where a block has a fixture. This leans on a convention the project already enforces — every new block visual must enter the gallery — so coverage follows a rule contributors already follow.

Because the gallery composes some exhibits inline rather than purely from fixtures, this binding is not fully automatic. The residual gap is closed the same way `theme-system` closes it for the palette matrix: a block that begins rendering text must be covered by the guard in the same change. Stated as a requirement, it is reviewable.

### D4 — The approval prompt becomes a gutter row, keeping the focus target on the outer box

The prompt restructures from a column of rows into a row of (fixed gutter, content column): an outer `<box flexDirection="row">` carrying `backgroundColor={theme().bgRaised}` and `flexShrink={0}`, a `<box width={size.gutter} flexShrink={0}>` holding the marker, and a `<box flexDirection="column" flexGrow={1}>` holding title, command, optional detail, and the hint row.

The load-bearing constraint is focus. The prompt's single key layer is gated on `target: boxRef`, and bare `y`/`a`/`n` are only legal because that target is a box and never an editor; the feedback `TextInput` must remain a *descendant* of the targeted box so the layer stays live in feedback mode. `boxRef` therefore stays on the **outermost** box, which continues to set `r.focusable = true`. `flexShrink={0}` on that outer box is also load-bearing — it is what stops the docked prompt collapsing below its own rows under the documented scrollbox-bleed behaviour.

*Alternative rejected:* padding the content rows to fake the indent. It produces the same pixels but leaves the marker owning a row, which is the thing being fixed, and it would not align the block to `size.gutter` the way every other stream block does.

### D5 — One ask vocabulary: `⚠` means "blocked on you", `◐` means "the system is working"

Today the same pending ask renders `⚠` docked and `◐` as a transcript card. Rather than pick one glyph arbitrarily, the split is drawn on meaning: `◐` already denotes system-busy across the app (chat thinking, harness booting, sidebar running), while a pending ask is not the system working — it is the system *stopped, waiting for the user*. That is what `⚠` denotes.

So the docked prompt and the transcript card's `pending` status both use `⚠` in the `warning` role, and `askMarker`'s terminal statuses keep their settled outcomes (`✓` success, `✗` error, `○` for aborted/expired). This removes a collision rather than relocating one.

### D6 — The openable card's marker column answers one question

The column currently encodes three different axes at once — content kind (`◐` chart, `◆` image, `▸` document, `✎` report), failure (`✗`), and a decorative title bullet (`●`) — using shapes that each already mean something else: `●` is the plan-card marker, multi-select "selected", the active radio dot, chat "ready" and three sidebar run states; `◐` is thinking/booting/ask-pending; `▸` is tool-running *and* the "Open containing folder" affordance inside this very card.

The redesign collapses it to a single question — **does this open, or is it broken?**

- Every openable row, including the folder-reveal row, takes `↗` (`GLYPHS.arrowUpRight`, U+2197) in the `accent` role. It is the conventional "opens outside this surface" affordance and it is honest about what the row does; the folder row is already distinguished by its `fgMuted` label and terminal position.
- A degraded row keeps `✗` in `error`, which now genuinely contrasts with the affordance instead of being a fifth kind glyph.
- The card title drops its `●` entirely. A bold title above indented rows is already a group; the bullet added no information and collided the most.

Content kind is not lost — it is carried by the filename and extension (`volcano.png`, `de-summary.csv`), which distinguishes kinds far better than four geometric glyphs can in a terminal. `↗` was verified to occupy a single cell in opentui's layout engine, so the fixed-gutter and no-double-width constraints hold.

*Alternative rejected:* remapping the four kind glyphs onto a non-colliding set. The glyph budget for single-cell, non-emoji, unambiguous shapes is nearly exhausted, and no available shape reads as "chart" versus "image" anyway — the differentiation was decorative in practice.

### D7 — `OpenableIcon` is deleted rather than left vestigial

`icon` is produced entirely inside the CLI: `iconForPath()` derives it from the file extension, plus four hardcoded call sites for chart/svg/report. No harness payload carries it. With the marker no longer varying by kind, the field has no reader, and a field with no reader is worse than no field.

Persisted rows are safe: parts are read as `JSON.parse(r.data) as Part` — an unchecked cast with no schema validation — so a stale `icon` key on a previously-written row is simply ignored. This was verified on the read path rather than assumed.

### D8 — Fixes use the `<Fg>` wrapper, though the `fg=` prop is equally valid

Both shapes were tested on `github-light`: a `<Bold>` inside `<text fg={theme().fg}>` inherits `#24292f`, and `<Fg role="fg"><Bold>` resolves the same. The eight sites take the `<Fg>` wrapper because each already has an `<Fg>`-wrapped sibling on the same line, so it is the smaller, more consistent diff. The authoring rule sanctions both, since a block whose every child should share one color is better served by the prop.

## Risks / Trade-offs

- **The guard's decorative classifier mis-tiers a span** (e.g. a legitimate text span composed only of dots, or a future ornament outside the derived set) → the classifier derives its set from `GLYPHS`, and a mis-tier fails *closed* in the dangerous direction: an unclassified span is measured at the stricter 4.5:1, so the failure mode is a loud false positive at authoring time, never a silently-shipped invisible span.
- **Guard coverage drifts as blocks are added** → mitigated by binding to the gallery's block set and by a same-change requirement mirroring the palette matrix's existing rule. Not fully eliminable; a block added to neither the gallery nor the guard is unprotected, which is why the rule is specced rather than left to habit.
- **`↗` renders emoji-style in some terminal fonts**, breaking the single-cell gutter → U+2197 has text presentation by default (emoji style requires an explicit VS16 selector), it sits in the same Arrows block as the `arrowUp`/`arrowDown` glyphs already shipping, and opentui measures it as one cell so layout is stable regardless. If a specific terminal is found to widen it, the mitigation is a one-line swap in `GLYPHS` with no call-site churn, because every row reads the same key.
- **Restructuring the prompt breaks the focus gate**, letting bare `y`/`a`/`n` leak into the composer or stranding feedback mode → `boxRef` and `focusable` stay on the outermost box with the input as a descendant; the existing focus-gating scenarios in `tui-ask-approval` plus the prompt's render tests pin the behaviour, and the mode-switch path (`backToChoice` refocusing via `queueMicrotask`) is unchanged.
- **Dropping content-kind glyphs loses at-a-glance differentiation** in a mixed gallery → accepted deliberately. The filename carries kind more reliably, and the column gains a meaning it can actually convey. Reversible: the kind data can be reintroduced from the file extension if a future design wants it.
- **Users on dark themes see no visible change** from the eight fixes, since white was already readable there → the fixes are still correct (the color moves from unthemed white onto the palette's `fg`, e.g. `#c0caf5` on tokyo-night), and the guard runs on the light theme where the failure is observable.
