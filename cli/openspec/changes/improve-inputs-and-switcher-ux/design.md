## Context

Three list surfaces share one fault: the row names an item and gives nothing that tells
two items apart.

- `FilePicker` lists an entry name only. `listDir` reads the directory with
  `withFileTypes` dirents and takes no `stat`, thus no size and no date exist to render.
- `RemoveInputDialog` lists `input.path`, which is relative to the anchor. It is a
  single-select dialog, thus one open removes one input.
- `SwitchAnalysisDialog` lists the analysis name, with the slug on the cursor detail line.
  A slug is unique within an anchor only, thus two folders can hold the same name and the
  same slug.

The list engine already carries the parts that this change needs. `SelectItem` has
`hint` (right-aligned, on the title line), `meta` (a muted line below the title), and
`description` (the bottom detail line of the cursor row). `hint` and `meta` are mutually
exclusive. A `category` groups rows under a header, and the header survives the filter.

## Goals / Non-Goals

**Goals:**

- Make each row of the three surfaces carry the facts that separate it from its siblings.
- Keep the syscall cost of the file picker bounded and stated.
- Use the existing helpers. Add no dependency.

**Non-Goals:**

- A detail dialog for a filesystem entry. Refer to Decision 3.
- A change to the input model, the staging path, or the provenance events.

## Decisions

### Decision 1: one `stat` for each entry, and no `access` call

The readability mark needs the answer to "can this user read this entry". The direct
test is `accessSync(path, R_OK)`. Measured on a warm cache over a 468-entry directory:

| Pass | 468 entries, cold | 468 entries, warm | 35 entries |
| --- | --- | --- | --- |
| `readdirSync` with `withFileTypes` | 0.24 ms | 0.21 ms | 0.05 ms |
| `statSync` for each entry | 48.89 ms | 0.69 ms | 0.07 ms |
| `accessSync(R_OK)` for each entry | — | 2.51 ms | 0.35 ms |

`access` costs 3 to 7 times what `stat` costs. The row already needs `stat` for the size
and the date, and a `Stats` object carries the mode bits, `uid`, and `gid`. Thus
readability is arithmetic over data that the listing holds. The process ids come from
`process.getuid()`, `getgid()`, and `getgroups()`, read one time for each picker mount.

Alternatives that this decision rejects:

- **`access` for each entry.** It doubles the syscalls and it is the slower call.
- **A batch syscall.** POSIX has no batch `stat`. Thus "batch" can only mean fewer calls.
- **A member count on a directory row.** It needs one `readdir` for each directory row.
  Measured over 467 directories: 54.46 ms cold and 4.91 ms warm, against 1.65 ms and
  0.68 ms for the `stat` pass. Thus a directory row carries no size field.

Accepted limit: the derivation reads mode bits, thus an ACL, a macOS TCC rule, and an
immutable flag are invisible to it. It can report "readable" where `open` fails. The
authoritative refusal stays at staging time, which already exists.

### Decision 2: a synchronous fill with an entry ceiling, not an asynchronous fill

The measurements show that a cold page cache is the real cost, not the syscall. An
asynchronous fill would keep the first frame fast. It is rejected for a hard reason:
`ListCore` resets the cursor to row 0 whenever the `items` array is minted again. A fill
that lands late mints the rows again, thus it moves the cursor while the user navigates.

A synchronous fill cannot have that defect. The ceiling covers the pathological
directory: above the ceiling the picker lists names alone and reports it in the footer.
468 entries cost 48.89 ms cold, which is under two frames at 30 frames for each second.

### Decision 3: no detail dialog for a filesystem entry

The first sketch put the permission bits, the owner, and the exact byte count in a
dialog that stacks over the picker. `dialogPush` keeps a lower entry mounted, hidden, and
inert, and it stores that entry's focused renderable for restore. Thus the browse state
costs nothing to preserve, and the objection was never the cost.

The dialog is rejected on value. The row carries the size, the date, and the permission
bits. Thus the dialog adds only the owner, the exact byte count, and a symlink target.
That does not earn a new block in the design gallery.

### Decision 4: the picker sets no `description`, thus it grows no detail line

The picker sets no `description` on a row today, thus it renders no bottom detail line.
The first sketch added one to hold the full path of the cursor row. That is rejected.

The line renders only when the cursor row carries a `description`, and it costs two rows:
a `space.sm` pad row inside its painted box, and the text row. The breadcrumb gives the
location, and REVIEW mode lists the selection with root-relative paths. Thus the detail
line would be a third copy that costs the listing two rows.

### Decision 5: the group key and the group header text become separate fields

`ListCore` keys a group on the `category` string and renders that same string as the
header. Thus "group on the anchor id, show the anchor path" is not expressible.

The switcher must group on the anchor id, not on the path. Two live anchors can hold one
cached path: delete a `.inflexa/id` marker, make a new one in the same folder, and the
old anchor row keeps that path. Keyed on the path the two merge, thus a dead anchor's
analyses mix with the current ones. That is the confusion that this change removes.

Thus `SelectItem` gains an optional header label. When it is absent the header text stays
the category string, and each existing caller is unchanged.

### Decision 6: an absolute local date, in two widths

The two custom `Date` extensions, `relativeAge` and `formatDuration`, are both relative.
The absolute form is the native `toLocaleString`, which `ls.ts`, `prov.ts`, and
`sidebar_live.ts` already use. A record listing is a durable record, thus the time rule
of `cli/CLAUDE.md` puts it on the absolute side.

The row uses the compact form, `{ dateStyle: "short", timeStyle: "short" }`, which is
about 16 columns. The cursor detail line uses the full form.

### Decision 7: the analysis id copies through the existing clipboard writer

`writeClipboard` emits an OSC 52 escape AND runs the native tool, thus it reaches a
terminal over SSH and a GUI clipboard. The switcher binds `ctrl+y` to copy the cursor
row's analysis id, and it reports the copy with a notice, as the chat surface does.

The chord carries the control key. A bare `y` cannot work: the switcher is a single-mode
picker, thus its filter input holds the focus for the whole life of the dialog. Ctrl, and
never Alt: a terminal delivers Alt unreliably, and macOS composes Option into a character.

The footer of the dialog names the chord, through a `footerHint` prop. `SelectDialog` owns
its footer and stays domain-agnostic. Thus a key that the HOST binds had no way to
advertise itself, and only the WhichKey overlay could find it.

### Decision 8: the anchor paths come from ONE query

The Switch analysis picker already reads its token totals in one batched query over the
listed ids, and never one query for each drawn row. The anchor paths obey the same rule:
one `listAnchors()` call builds a map from anchor id to cached path. A missing anchor
degrades to the wording that `prov.ts` uses for an unknown folder.

### Decision 9: the `lg` preset grows, rather than a fourth tier

Issue #26 asks for a bigger dialog. Three shapes answer it: grow `lg`, add a tier between
`lg` and `xl`, or move these three dialogs to `xl`.

`lg` grows to 108 columns by 28 rows. Each consumer of `lg` is a list, and each one gains
together: the picker, the select dialog, the results dialog, the usage dialog, and the run
detail dialog. The vocabulary stays at three tiers.

A fourth tier is rejected. It buys one more decision at each new dialog, for a role that
`lg` already names: "pickers, lists, results".

`xl` is rejected. Its role is a full showcase and a gallery, thus a file picker that fills
the terminal is a different feel from a modal.

The width follows the row. An entry spends about 35 columns on its permissions, its size,
and its date. The height leaves about 20 rows for the list after the chrome of the panel.

### Decision 10: a footer names only the keys of its own surface

The movement vocabulary is app-wide, and each navigable surface carries the same set. The
WhichKey overlay documents it live. Thus a footer that restates it spends the width of the
row on what the user knows, and it reads as though this one list moves differently.

`↑/↓ move` leaves each footer. The mode word stays, because the same keystroke does
different things in each state and nothing else on the screen says which state is live.

The breathing row above a footer belongs to `DialogPanel`, thus each dialog gets it at one
time. The pad sits inside the painted box, because a transparent gap under a `flexGrow`
scrollbox lets the scrolled content bleed through it.

## Risks / Trade-offs

- **A slow or network filesystem makes the listing wait.** → The entry ceiling bounds the
  work, and the footer states that the metadata is absent for that directory.
- **The readability mark can be wrong under an ACL.** → Staging keeps the authoritative
  check, and the mark never blocks a selection. It only colors the row.
- **Windows has no `process.getuid` and reports synthetic mode bits.** → Windows renders
  no permission column and no readability mark.
- **A grouped switcher loses the flat recency order.** → Group order is the first
  appearance in ranked order, and `listRecentAnalyses` is already sorted by recency. Thus
  the groups come out ordered by their newest analysis with no sort of their own.
- **The switcher row becomes two lines with the group header.** → A header renders one
  time for each group, not for each row. Thus a folder with three analyses costs one line.
- **Four new visual states arrive at one time.** → Each takes a design gallery entry in
  the same change, which keeps the gallery the single source of truth.

## Open Questions

None. Each decision above is settled.
