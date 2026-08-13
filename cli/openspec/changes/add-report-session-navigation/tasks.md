# Tasks: add-report-session-navigation

## 0. The harness link

- [x] 0.1 Run `bun run harness:local` from `cli`. The thread listing and the report-session surface of this work live on the delivery branch, and the pinned npm version does not carry them. A plain install restores the stale snapshot, thus the link comes first.

## 1. The thread reads

- [x] 1.1 Add the read of the report children of one conversation, narrowed by the parent thread id and the `report` type. Put it beside the session seams that the palette flows already use, thus a flow stays injectable for an offline case.
- [x] 1.2 Add the read of the parent conversation of one report child. A row that no longer resolves gives an absence, and not an error.
- [x] 1.3 Make each of these reads take the live children alone. An archive sets a tombstone over the subtree, thus an archived child leaves each surface on its own.
- [x] 1.4 Narrow the launch-thread read of `hooks/thread.ts` to the `conversation` type. The listing orders by the last activity, thus an unfiltered read opens a fresh report child at the next launch.

## 2. The keybind pair

- [x] 2.1 Add the ids `session.open-parent` and `session.open-report` to `KEYBIND_DEFAULTS`, with the defaults `left` and `right`. Comment the reason that a ctrl-arrow is not the default.
- [x] 2.2 Declare the two bindings in the chat shell, each as the leader chord followed by the resolved chord of its id. Give each a description and a group, thus the reachable-keys overlay documents the pair.
- [x] 2.3 Write the back flow: a report child opens its parent, a conversation gives a notice, and an absent parent gives a notice.
- [x] 2.4 Write the forward flow: one child opens with no picker, more than one opens a picker, no child gives a notice, and a report child gives a notice.
- [x] 2.5 Restate the boot gate inside each flow, because a chord dispatches by id and it bypasses the offer predicate.

## 3. The palette

- [x] 3.1 Add the command `session.report-switch`, titled "Switch report session", to the registry in the Session category.
- [x] 3.2 Write its flow on the shape of the switch flow: read the listing, read the open analysis again, then open the picker. A changed analysis gives a notice and opens no dialog.
- [x] 3.3 Narrow the switch listing to the `conversation` type, and keep its pinned creation row.
- [x] 3.4 Share one listing and one picker between this command and the forward chord. A report row reads as a session row, thus it carries the title and the last-activity stamp of the switch picker.

## 4. The chat entry point

- [x] 4.1 Hold the report children of the open conversation as a reactive read. It refreshes when the open thread changes, and when a turn settles, because a turn is what spawns a report session.
- [x] 4.2 Keep the sequence number of each loaded message beside the first message that its row opened. The conversion to the display messages drops the sequence number, thus the load path holds the pair itself.
- [x] 4.3 Render an openable entry for each child after the last loaded message whose sequence number is not greater than the anchor. An anchor past the loaded transcript renders at the end, and an anchor below the mounted window renders at the top.
- [x] 4.4 Open the child in place from that entry.
- [x] 4.5 Take each glyph from `GLYPHS` and each color from `theme`. Consult the design gallery first, then add the entry to the gallery, because the entry is a new block.

## 5. The coverage

- [x] 5.1 Cover each flow of the keybind pair, and cover each notice arm.
- [x] 5.2 Cover the report picker, the narrowed switch picker, and the changed-analysis refusal.
- [x] 5.3 Cover the chat entry: the anchor position, the anchor past the end, the anchor below the mounted window, the failed listing, and the archived child.
- [x] 5.6 Cover the two edges of the listing: a bind to a different thread, and a turn that settles.
- [x] 5.4 Cover the narrowed launch read: an analysis whose newest thread is a report child opens the newest conversation.
- [x] 5.5 Seed a report thread in Postgres directly, because no local composition writes one yet.

## 6. The gates

- [x] 6.1 Run `bun run format` on the changed files.
- [x] 6.2 Run `bun run typecheck` and `bun run lint`.
- [x] 6.3 Run the targeted files of the changed modules, and never the whole suite.
- [x] 6.4 Run `openspec validate add-report-session-navigation --strict`.
