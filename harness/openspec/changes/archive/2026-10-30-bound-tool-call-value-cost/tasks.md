# Tasks

## 1. The secret rules

- [x] 1.1 In `harness/src/input-sanitization.ts`, let a quoted value with no closing quote hold the rest of the text, for an assignment and for a quoted field
- [x] 1.2 Cover an unclosed double quote, an unclosed single quote, a final backslash, and an unclosed quoted field in `harness/src/test/input-sanitization.test.ts` and `harness/src/loop/test/tool-value.test.ts`

## 2. The bound of a long value

- [x] 2.1 In `harness/src/loop/tool-value.ts`, clean only the two windows of a text longer than 24,576 code units, and count the original text in the marker line
- [x] 2.2 For a JSON value whose JSON text is longer than 24,576 code units, clean a copy of each end of the value only
- [x] 2.3 Cover a secret at each cut, the marker count, and the equality of the shown text with the cut of the plain JSON text for records, arrays, long strings, a date, and an omitted field
- [x] 2.4 Measure the cost before and after on inputs of 100,000, 1,000,000, and 10,000,000 characters
