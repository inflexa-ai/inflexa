## Why

Three list surfaces name an item but give nothing to tell two items apart. The file
picker shows a bare entry name, thus the user cannot compare two candidate inputs. An
unreadable entry also stays hidden until staging fails. The flat inputs list shows
an anchor-relative path, and it removes one input for each open. The Switch analysis
picker shows the analysis name only, thus two analyses that carry the same name in
different folders render as identical rows. GitHub issue #26 records the first two, and
the third came from the same review.

## What Changes

- The file picker row carries the entry size, the modification date, and the permission
  bits. An entry that the user cannot read renders in the warning color.
- The file picker takes ONE `stat` for each entry and derives readability from the mode
  bits and the owner ids. It takes no `access` call. Above an entry ceiling it lists the
  names alone and says so in the footer.
- The file picker adds no bottom detail line for the full path. The breadcrumb gives the
  location and REVIEW mode gives the selection, thus a third copy costs two rows and
  tells the user nothing new.
- The flat inputs list becomes multi-select, and it removes each selected input in one
  pass. Its row title becomes the absolute path, with the kind, the size, and the date
  on a meta line below.
- The Switch analysis picker groups its rows by anchor, under a header that shows the
  anchor folder. The row carries an absolute local date, not a relative age. The cursor
  detail line carries the analysis id, the slug, and the full creation date. A `y` key
  copies the analysis id to the clipboard.
- `SelectItem` gets an optional field that separates the group key from the group header
  text. Today the category string is both, thus a group cannot be keyed on an anchor id
  and titled with a path.

## Capabilities

### New Capabilities

None. Each change modifies an existing capability.

### Modified Capabilities

- `file-picker`: the listing gains entry metadata and a readability mark, the detail line
  goes away, and the listing declares its syscall budget and its entry ceiling.
- `list-primitives`: `SelectItem` gains a group header label that is separate from the
  category key.
- `analysis-input-management`: the flat inputs surface becomes a multi-select removal
  list that shows absolute paths.
- `command-palette`: the Switch analysis picker groups by anchor, renders absolute dates,
  carries a cursor detail line, and copies the analysis id.

## Impact

Code:

- `src/tui/components/dialog/file_picker.tsx` — the listing, the row hints, the entry
  ceiling, and the removal of the `description` line.
- `src/tui/components/list_core.tsx` — the group header label field.
- `src/tui/commands.tsx` — `RemoveInputDialog` and `SwitchAnalysisDialog`.
- `src/lib/fs.ts` — the readability derivation from a `Stats` object and the process ids.

Existing helpers that this change uses, and does not duplicate: `Number.formatBytes`,
`contractHome` (`lib/paths.ts`), `writeClipboard` (`lib/clipboard.ts`), `listAnchors`
(`db/primary_query.ts`), and the native `toLocaleString`.

Design system: the readability color, the row hint on a picker entry, the group header
label, and the multi-select inputs list are new states. The design gallery takes an
entry for each.

Dependencies: none added.

Platform: `process.getuid` does not exist on Windows, and Node reports synthetic mode
bits there. Windows renders no permission column and no readability mark.
