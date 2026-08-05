## ADDED Requirements

### Requirement: The footer of a panel carries a painted breathing row above it

`DialogPanel` MUST render one row of top padding above its footer text. That padding MUST sit
INSIDE the painted footer box, and never as a transparent gap above that box.

A fixed chrome row that sits directly below a `flexGrow` scrollbox lands one cell inside the
last row of that scrollbox. This is the yoga overlap that `cli/CLAUDE.md` records. Thus an
unpainted pad lets the scrolled content bleed through it.

A painted pad row does two things at one time. It reclaims the bled cell, and it separates the
keys from the content of the dialog.

#### Scenario: The keys do not touch the last row of the list

- **WHEN** a picker fills its list to the bottom of the panel
- **THEN** one blank painted row separates the last list row from the footer text

#### Scenario: Scrolled content does not bleed into the pad

- **WHEN** the user scrolls a full list under the footer
- **THEN** the pad row stays blank, and no list content shows through it

### Requirement: A footer names only the keys of its own surface

A footer MUST name the verbs that belong to that surface. Examples are `space toggle`, `enter
confirm`, `i filter`, `c apply`, and `esc cancel`.

A footer MUST NOT name a key that moves the cursor. The movement vocabulary is app-wide, and
each navigable surface carries the same set: the arrows, `ctrl+p` and `ctrl+n`, the page keys,
and in NORMAL the vim keys `j`, `k`, `gg`, and `G`. The WhichKey overlay documents them live.

A restatement of that vocabulary spends the width of the row on what the user knows. It also
reads as though this one list moves differently from each other list.

A multi-select footer MUST lead with its mode word, `NORMAL` or `INSERT`. The same keystroke
does different things in each state, and nothing else on the screen says which state is live.

#### Scenario: A picker footer names no arrow

- **WHEN** a file picker renders its footer in NORMAL or in INSERT
- **THEN** the footer names no cursor key, and it keeps its own verbs

#### Scenario: The mode word leads a multi-select footer

- **WHEN** a multi-select dialog holds the focus in its filter input
- **THEN** the footer starts with `INSERT`, and a blurred filter starts it with `NORMAL`

### Requirement: A row of a list clears the scrollbar

A list row MUST carry one column of right padding. The scrollbox paints its scrollbar over the
right edge of the content. Thus a right-aligned hint touches the bar without that padding.

#### Scenario: The hint does not touch the bar

- **WHEN** a list is long enough to show its scrollbar
- **THEN** one blank column separates the end of the hint from the bar
