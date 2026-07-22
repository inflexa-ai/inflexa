## Context

`chooseIds` in `cli/src/modules/refs/commands.ts` is the one interactive selection surface behind two entry points: `inflexa setup` (no `--refs`) and `inflexa refs download` with no ids. Today it opens a `select` over four presets and only reaches the grouped `groupMultiselect` when the user picks "choose specific datasets…".

Two facts about the surrounding code drive this design.

**The offered set is not the catalog.** `offeredReferenceCatalog` filters out datasets whose inspection state is `installed`, because re-offering an intact dataset would let "Everything" mean "re-fetch what you already have". With the catalog's 32 recommended / 24 optional split, an install of the recommended set leaves an offered set with zero recommended datasets — and the preset builder, which derives its entries from the offered set, then has no Recommended entry to render. This is the reported defect, and it is a *consequence* of correct filtering, not a bug in the filter.

**`@clack/prompts` hides the prompt instance.** `groupMultiselect(opts)` constructs a `GroupMultiSelectPrompt`, passes it a closure `render()`, and immediately returns `.prompt()`. There is no handle to attach a key listener to, and `updateSettings({aliases})` only remaps keys onto the existing action set (`up`/`down`/`left`/`right`/`space`/`enter`/`cancel`) — it cannot introduce a new action. Bulk-selection keys therefore require constructing the prompt class directly.

## Goals / Non-Goals

**Goals:**

- The selection surface always shows the datasets it is about to install.
- Recommended is reachable in one keystroke regardless of what is already installed, and never silently absent.
- Narrowing a selection never requires deselecting a wall of pre-ticked boxes.
- What the list omits is stated, not inferred by the reader.
- The bulk-key resolution and the picker's contents are assertable without a terminal.

**Non-Goals:**

- Any change to the installer, the progress readout, byte formatting, or concurrency.
- Any change to non-interactive behavior: `--refs`, `refs download <ids>`, headless `--yes` defaults, JSON modes.
- Re-offering installed datasets for selection outside `--force`. Selecting one is a no-op the estimate already nets out; listing it as pickable would advertise work that will not happen.
- Marking individual rows as installed. The disclosure is a count above the list, not a per-row state.

## Decisions

### Construct `GroupMultiSelectPrompt` from `@clack/core` rather than calling `groupMultiselect`

`@clack/core` is already on disk: `@clack/prompts@1.7.0` depends on it at the exact version `1.4.3` (not a range), so declaring it directly adds no resolution risk and no bytes. The class is a public export with published typings; `options`, `cursor`, `value`, `getGroupItems`, and `isGroupSelected` are all public, and the base `Prompt` exposes `on(event, cb)`.

The key mechanism is `Prompt.onKeypress`: it emits `"key"` with the character, and then calls `this.render()` unconditionally at the end of the same invocation. A `"key"` handler that reassigns `this.value` is therefore repainted on the same keystroke — no manual re-render, no timing coupling. Verified under a pty across the whole matrix (`a`, `n`, `r`, `a n`, `r` then space-toggle, group toggling, `esc`).

Alternatives rejected:

- **Pseudo-entries in the list** (`@all`, `@recommended` rows the user toggles, post-processed after submit). Zero new dependencies, but selecting `@all` leaves the 24 real checkboxes visually untouched — it fails the requirement that the selection be *visible*, which is the point of the change.
- **Interposing a stream between stdin and the prompt**, translating `a` into synthetic navigation and space keystrokes. Requires modelling the prompt's internal selection state from outside; brittle against any change to option ordering or group semantics.
- **Hand-rolling the prompt on raw stdin.** Re-implements raw mode, frame diffing, cursor management, and cancel handling — precisely what `Prompt` already provides, at a much larger correctness surface.

### Bulk keys replace the selection; `r` is inert when nothing offered is recommended

`a`/`n`/`r` read as presets, so each sets the selection outright rather than unioning with it — that is what makes `n` a one-keystroke escape from a large selection, which is what allows the picker to be the only surface.

`r` is the exception: when the offered set contains no recommended dataset, `r` does nothing rather than resolving to the empty set. A key labelled "recommended" that clears the user's work is a trap, and the honest reading of "there is nothing to recommend here" is "this key has no effect", not "select none" — `n` already means that. The footer annotates the key in that state instead of hiding it, because the defect being fixed *is* the option disappearing.

### The bulk-key resolution is a pure function over a picker model

Rendering and key handling both read one value:

```
ReferencePickerModel = { groups, everything, recommended, footer }
```

`referencePickerModel(catalog)` builds it; `referencePickerBulkSelection(char, model)` maps a keystroke to the new selection, or `undefined` for a key that is not a bulk action (including `r` with nothing to recommend). Both are exported and tested without a terminal, the same shape the removed `referencePresetPrompt` used. The prompt wiring left over — construct, subscribe, await — is the part a test cannot reach and the part with no branching.

### An empty recommended key names its cause on the key itself

`(none offered)` is true and unhelpful: it states the symptom and withholds the reason, which is exactly the gap that made the missing preset read as a defect. Where the offered set has no recommendation *because* the recommended datasets are installed, the legend says so with the count — `r recommended (32 already installed)` — and the neutral wording survives only for an offer that genuinely never carried one. The count is of *recommended* withheld datasets, not of every withheld dataset: those diverge the moment an optional dataset is installed too, and only the recommended ones explain this key.

Putting it on the key rather than in the pre-picker disclosure is the point. Someone hunting for the option they used last time is looking at the legend, so the answer belongs where the question is asked; the disclosure above the list is left saying one thing, the count of what is not listed.

### The note floats beside the listing where the terminal allows

Above the list, the note costs three to nine rows of listing and scrolls away the moment the user moves. Floated as a bordered panel down the right, it stays visible for the whole interaction and costs nothing vertically — and the reference step routinely runs in a terminal with a hundred idle columns to its right.

The layout follows from one decision made in `chooseIds`, not two: a width check in the printer and another in the renderer could disagree across a resize and print the note twice or not at all, so the caller decides once and either hands the renderer a panel or prints prose. `limitOptions` receives the reserved columns as `columnPadding`, so rows wrap before the panel rather than under it, and every row is padded to a fixed gutter column — measured on `stripVTControlCharacters` output, since a row's `.length` counts colour bytes the terminal never draws and padding to it would step the panel left row by row.

Rows are extended when the panel is the taller of the two, which keeps the box closed on an offer of only a few datasets. Below the width threshold the note reverts to prose above the list, where narrowness costs nothing. The copy is stored once as unwrapped paragraphs and wrapped at render time to whichever width applies, so the two layouts cannot drift; the command line is its own paragraph and is never reflowed, because a wrapped command is an uncopyable one.

### The disclosure is computed by the caller, passed to the picker

`chooseIds` takes the offered catalog plus the datasets being withheld. Setup already holds the inspection. `refs download` with no ids does not, so it performs one `inspectReferenceStore` on that path only — interactive, no ids, before any transfer — and under `--force` withholds nothing, because a forced run genuinely re-fetches an intact dataset and hiding it would remove the only interactive way to repair one.

The disclosure states one fact, and only when true: the count of datasets already installed and intact. Why the recommended key may be empty lives on that key, per the decision above.

### The on-demand note is stated once, before the choice

It informed nothing where it was: announced only *after* an empty selection, it consoled a decision already made. Stated before the picker it frames the choice — `n` and Enter is a supported outcome, not a failure — which is what it was asked for. It is not repeated after submission; the same paragraphs twice in one screen read as an error message.

## Risks / Trade-offs

- **A direct `@clack/core` import couples this file to a package `@clack/prompts` may re-pin.** → The version is exact-pinned in `package.json` rather than a caret range, so a `@clack/prompts` minor that moves to a new core version surfaces as a duplicate install and a typecheck, not as silent drift.
- **The custom `render` is presentation code that clack would otherwise own**, so a future clack restyle will not reach it. → It is built from clack's own exported symbols (`S_BAR`, `S_BAR_END`, `S_CHECKBOX_*`, `symbol`, `limitOptions`), so the scrolling window, wrapping, and glyph vocabulary stay clack's; only the composition is local.
- **`a`/`n`/`r` are unavailable as type-ahead.** → The prompt has no filter input, so no keystroke is being taken from an existing use. Vim aliases (`k`/`j`/`h`/`l`) are the only reserved letters and none collide.
- **The whole list is now the first thing shown, for a catalog that can reach 56 entries.** → `limitOptions` gives the same sliding window `groupMultiselect` uses, sized to the terminal; the offered set is usually smaller than the catalog, and `a`/`r` mean the long list never has to be traversed to make the common choices.

## Migration Plan

Not applicable — an interactive prompt with no persisted state. `--refs`, `refs download <ids>`, and every headless path are untouched, so scripted and CI callers see no difference.
