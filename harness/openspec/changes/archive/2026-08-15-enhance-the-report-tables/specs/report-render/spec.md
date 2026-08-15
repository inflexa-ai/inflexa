# Delta: report-render

## ADDED Requirements

### Requirement: The table enhancer
The page MUST enhance each rendered table with a header sort, one filter input, and a row cap, through a page script with no dependency. The DOM MUST hold every resolved row, and the enhancer hides a row with a class and never removes one. The sort MUST read a raw value attribute that the view emits, thus the formatted text stays presentation. A numeric column sorts numerically, and every other column sorts in code-unit order. The cap is a renderer constant, and a table over the cap MUST carry a toggle that names the total row count. The print form MUST show every row. A browser without script keeps the complete plain table.

The renderer MUST trim a percent-delimited display name to its first segment. The full text rides the `title` attribute.

#### Scenario: The rows stay in the DOM under the cap
- **WHEN** the caller renders a table with more rows than the cap
- **THEN** the markup holds every row, the rows past the cap carry the hidden class, and the toggle names the total

#### Scenario: A sort reads the raw value
- **WHEN** the view renders a numeric cell with a formatted text
- **THEN** the cell carries the raw value in a data attribute, and the enhancer sorts by that value

#### Scenario: A small table carries no toggle
- **WHEN** the caller renders a table at or under the cap
- **THEN** no row carries the hidden class, and no toggle renders

#### Scenario: A noisy name trims with the full text on hover
- **WHEN** a cell holds a percent-delimited set name
- **THEN** the cell shows the first segment, and the `title` attribute holds the full text

#### Scenario: The print form shows every row
- **WHEN** the reader prints a page with a capped table
- **THEN** the print rules reveal each hidden row

#### Scenario: A scriptless browser sees the whole plain table
- **WHEN** the page loads with scripting disabled
- **THEN** every row paints, and no inert control shows, because the sheet hides and shows only under the live marker
