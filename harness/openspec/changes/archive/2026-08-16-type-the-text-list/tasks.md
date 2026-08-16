# Tasks: type-the-text-list

## 1. The contract

- [x] 1.1 `TextBlockSchema.content` gains the optional `list`: the ordered flag, and the non-empty items, in `src/contracts/report-blocks.ts`. The field description teaches the enumeration case.

## 2. The render

- [x] 2.1 The text view renders the list after the prose paragraphs, `ol` or `ul` by the flag, escaped as a paragraph.
- [x] 2.2 The list styles fill the content column in the design source.

## 3. The advisory

- [x] 3.1 The free-numeral walk covers the list items beside the prose.

## 4. The proof

- [x] 4.1 Tests cover the four delta scenarios, and a block with no list renders byte-identically.
- [x] 4.2 Run the targeted suites of the touched modules, and `tsc -p tsconfig.json`.
