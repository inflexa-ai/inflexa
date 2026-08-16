# Delta: report-render

## REMOVED Requirements

### Requirement: The table enhancer

## ADDED Requirements

### Requirement: The table grid

The page MUST render each table block through the pinned grid bundle, booted by the page script from the registered data of the block. The bundle joins the asset manifest, and the page references it as a classic script. The client-side row model virtualizes the DOM, thus the page holds the visible slice alone.

The payload MUST carry a display member: the resolved header label of each column, the resolved number kind, and the below-resolution bound where one exists. The server resolves, and the page formats over the shipped kinds. A shared test vector MUST pin the client formatter against the server helper.

The grid theme MUST build from the design tokens, thus the grid reads as the page does. The per-column filters and the header sort are the one filter surface, and no separate filter input renders. The full raw value of a formatted cell rides the cell tooltip, exactly as the `title` attribute carried it.

The renderer MUST trim a percent-delimited display name to its first segment, with the full text on the cell tooltip. The print form MUST take the grid's print layout, up to a stated print cap. A larger table prints its first rows, and a printed line names the truncation and the download. A grid mount whose payload the registry does not hold keeps the header card and the download link, and the boot skips it.

#### Scenario: The grid renders the bounded table

- **WHEN** the page loads with a table block of 14,201 registered rows
- **THEN** the grid shows the rows with sort and per-column filters, and the DOM holds the visible slice alone

#### Scenario: The client formats as the server does

- **WHEN** the shared vector runs through the server helper and the client formatter
- **THEN** the two give identical text for every entry

#### Scenario: No filter row renders

- **WHEN** the page renders any table block
- **THEN** no standalone filter input sits above the grid, and the column filters serve

#### Scenario: The print shows the bounded rows

- **WHEN** the page prints a table block at or under the print cap
- **THEN** the print form holds every row, and no scroll viewport clips one

#### Scenario: A giant table prints with a stated truncation

- **WHEN** the page prints a table block over the print cap
- **THEN** the print holds the first rows, and a printed line names the truncation and the download

#### Scenario: A missing payload keeps the card honest

- **WHEN** a grid mount finds no registered data under its block id
- **THEN** the header card and the download link stay, and the page throws nothing

## MODIFIED Requirements

### Requirement: A rendered form for each block kind

The table block MUST render through the grid over its payload, and the payload holds the rows in place of the markup.

#### Scenario: A table shows every resolved row through the grid
- **WHEN** the caller renders a table block whose value entry holds three rows
- **THEN** the payload holds the three rows, the grid shows them, and no sample note renders

#### Scenario: An empty table keeps its card
- **WHEN** the caller renders a table block whose value entry holds zero rows and named columns
- **THEN** the card holds the title and the download link, and the payload holds the columns with no row
