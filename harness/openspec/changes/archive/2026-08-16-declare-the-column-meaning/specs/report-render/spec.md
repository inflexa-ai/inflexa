# Delta: report-render

## MODIFIED Requirements

### Requirement: The number format of a resolved value
The renderer MUST format each numeric value that it shows, through one number helper with three kinds: `scientific`, `compact`, and `compact-scientific`. The helper applies to the metric value and to each numeric table cell. The renderer picks the kind by magnitude and by column meaning, and no block carries a format field.

The chart option rides as inline JSON, thus no function can format an axis tick. The derivation MUST bound an axis only where a static option field can state the bound. The count axis of a histogram holds whole ticks. Every other axis keeps the tick algorithm of the chart runtime.

When the shown form hides digits, the element MUST carry the full digits in its `title` attribute. When the shown form hides no digit, the element carries no `title` attribute. The helper MUST be deterministic: it reads no locale, thus the same value gives the same text on every host.

The kind resolution MUST read a declared column meaning first, and the name guess is the fallback for an undeclared column. A declared meaning replaces the name test alone, and the magnitude arms stay. Thus a declared column renders byte-identically to a name-matched column of the same nature.

#### Scenario: A p-value renders in the scientific kind
- **WHEN** the caller renders a metric whose value resolves to `0.0000427777663038`
- **THEN** the card shows a scientific form such as `4.3e-5`, and the `title` attribute holds the full digits

#### Scenario: A long float renders with few significant digits
- **WHEN** the caller renders a table cell that holds `-3.089028528355109`
- **THEN** the cell shows a short form such as `-3.09`, and the `title` attribute holds the full digits

#### Scenario: A count renders in the compact kind
- **WHEN** the caller renders a value that is a large integer count such as `14201`
- **THEN** the text shows the grouped form `14,201`, and the `title` attribute holds the full digits only when the shown form hides a digit

#### Scenario: A short value carries no tooltip
- **WHEN** the caller renders a value whose full form already shows every digit, such as `42`
- **THEN** the text shows `42`, and the element carries no `title` attribute

#### Scenario: A non-numeric cell passes through
- **WHEN** the caller renders a table cell that holds the text `up`
- **THEN** the cell shows `up` unchanged

#### Scenario: A count axis holds whole ticks
- **WHEN** the caller derives a histogram option
- **THEN** the count axis carries a whole-tick bound, thus no count tick shows a fraction

#### Scenario: A declared meaning beats the name guess

- **WHEN** the caller renders a small numeric cell of a column declared `p-value`, whose name matches no token
- **THEN** the cell renders in the scientific kind, and the `title` attribute holds the full digits

#### Scenario: The magnitude arms survive a declaration

- **WHEN** the caller renders `0.536` in a column declared `p-value`
- **THEN** the cell shows `0.536`, exactly as a token-matched p-value column shows it

## ADDED Requirements

### Requirement: A declared display label names the column

The table header MUST show the declared label of a column, with the raw column name in the `title` attribute of the header. An axis whose channel reads a labeled column MUST carry the label as its axis title. An undeclared header MUST prettify as the fallback: underscores become spaces, with the raw name on hover when the two differ. An undeclared axis keeps the raw name.

#### Scenario: The header shows the label with the raw name on hover

- **WHEN** the table view renders a column declared with a display label
- **THEN** the header shows the label, and the `title` attribute of the header holds the raw name

#### Scenario: The axis carries the label

- **WHEN** the chart derivation names an axis for a channel whose column carries a declared label
- **THEN** the axis title is the label, and the derivation stays deterministic

#### Scenario: An undeclared header prettifies

- **WHEN** the table view renders the column `gene_symbol` with no declared label
- **THEN** the header shows `gene symbol`, and the `title` attribute of the header holds the raw name
