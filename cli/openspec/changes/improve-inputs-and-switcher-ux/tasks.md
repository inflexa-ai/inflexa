## 1. The list engine

- [x] 1.1 Add the optional `categoryLabel` field to `SelectItem` in `list_core.tsx`
- [x] 1.2 Carry the label into `RowMeta`, and render it as the group header text
- [x] 1.3 Keep the `category` string as the header text when no label is present
- [x] 1.4 Cover the key and the label as separate values with a render test

## 2. The readability helper

- [x] 2.1 Add a readability function to `lib/fs.ts` that takes a `Stats` object
- [x] 2.2 Take the uid, the gid, and the group list of the process as parameters
- [x] 2.3 Give a `null` result on Windows, where `process.getuid` does not exist
- [x] 2.4 Cover the owner case, the group case, the other case, and the root case

## 3. The file picker listing

- [x] 3.1 Add the size, the modification time, and the mode bits to the `Row` type
- [x] 3.2 Take one `statSync` for each entry in `listDir`, and take no `accessSync`
- [x] 3.3 Keep a row whose `stat` failed, with no metadata on it
- [x] 3.4 Add the entry ceiling, above which `listDir` takes no `stat`
- [x] 3.5 Read the process ids one time for each mount, not for each entry
- [x] 3.6 Cover the ceiling and the failed `stat` with unit tests

## 4. The file picker row

- [x] 4.1 Build the row `hint` from the mode bits, the size, and the compact date
- [x] 4.2 Render a directory row with its date and no size field
- [x] 4.3 Render an unreadable row in the warning color of the theme
- [x] 4.4 Report the absent metadata in the footer above the ceiling
- [x] 4.5 Set no `description` on any row
- [x] 4.6 Assert the resolved span color of an unreadable row with `captureSpans`

## 5. The flat inputs list

- [x] 5.1 Change `RemoveInputDialog` to a multi-select list
- [x] 5.2 Remove each selected input through `removeInput`, one call for each row
- [x] 5.3 Collect the failures, and report them without stopping the pass
- [x] 5.4 Title each row with the absolute path from `resolveInputPath`
- [x] 5.5 Add the `meta` line with the kind, the size, and the date
- [x] 5.6 Report an absent file on the `meta` line, and keep the row removable
- [x] 5.7 Rename the palette entry to match the new multi-select behavior
- [x] 5.8 Cover a two-input removal and an input outside the anchor folder

## 6. The analysis switcher

- [x] 6.1 Read every anchor with ONE `listAnchors()` call, into a map by anchor id
- [x] 6.2 Group the rows on the anchor id, and title each group with `contractHome`
- [x] 6.3 Degrade a missing anchor to the unknown-folder wording
- [x] 6.4 Build the row `hint` from the compact absolute date and the token figure
- [x] 6.5 Add the cursor detail line with the id, the slug, and the full date
- [x] 6.6 Bind `ctrl+y` to copy the analysis id through `writeClipboard`, and notify
- [x] 6.7 Use a control chord, because the filter input never releases the focus
- [x] 6.8 Cover the duplicate-name case, the missing anchor, and the copy

## 7. The design gallery

- [x] 7.1 Add the file picker row with its metadata hint and its unreadable state
- [x] 7.2 Add the multi-select inputs list with its absolute paths
- [x] 7.3 Add the grouped switcher with its header label and its detail line

## 8. The close-out

- [x] 8.1 Run `bun run format:file` on each changed file under `src/`
- [x] 8.2 Run `bun run typecheck` and `bun run lint`
- [x] 8.3 Run `bun run test`

## 9. The review pass

- [x] 9.1 Right-align the hint column, and clear the scrollbar with a right pad
- [x] 9.2 Add a painted breathing row above each dialog footer
- [x] 9.3 Drop each cursor key from each footer, and keep the mode word
- [x] 9.4 Mount a multi-select dialog in NORMAL, as the file picker does
- [x] 9.5 Name the copy chord in the footer of the switcher
- [x] 9.6 Grow the `lg` preset to 108 by 28, and derive its tests from the preset
