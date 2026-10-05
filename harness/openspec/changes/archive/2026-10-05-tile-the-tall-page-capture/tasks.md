# Tasks: tile-the-tall-page-capture

## 1. The list convention of the tool pictures

- [x] 1.1 Add `withToolResultImages` and `readToolResultImages` to `src/tools/define-tool.ts`; the reader tolerates the one-image shape and gives an ordered list.
- [x] 1.2 Generalize the three placement arms in `src/loop/run-agent.ts`: `[text, ...files]` on the tool result, each picture into the deferred collector in order with a numbered label, one warn with the count on the drop.
- [x] 1.3 Tests: the multi-picture tool result, the multi-picture fallback message, and the counted drop warn.

## 2. The tiled capture

- [x] 2.1 Measure the document height after the settle in `src/lib/page-capture.ts`; a failed measure reads as a short page.
- [x] 2.2 Slice a page past `TILE_HEIGHT_PX` into consecutive clips of that height, up to `MAX_TILES`, in document order; a short page keeps the one full-page shot.
- [x] 2.3 Reshape `PageCapture`: `screenshots` with per-slice ranges, and the coverage discriminant with the honest `capturedPx` / `totalPx` accounting.
- [x] 2.4 Keep the Chrome-refusal degradation around both shapes: one retry at the window, cause chained on a second throw.
- [x] 2.5 Tests: the short page, the tile count and the ranges of a tall page, the truncation accounting past the budget, and the refusal arm.

## 3. The eyes tool and the prompt

- [x] 3.1 Carry the coverage discriminant and the `tiles` ranges on the `examined` outcome of `src/tools/report-session/examine-page.ts`, and attach the slices in document order through `withToolResultImages`.
- [x] 3.2 Teach the sliced look and the unseen tail in `src/prompts/report-session.ts`: the slices read as one page, and a truncated coverage means the tail was not seen.
- [x] 3.3 Tests: the tiled outcome shape, with the ranges on the JSON and the slices on the image path.

## 4. The proof

- [x] 4.1 Run the touched suites, the whole `src/loop/` suite, `bun run typecheck`, and `bun run lint`.
