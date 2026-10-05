# Proposal: tile-the-tall-page-capture

## Why

A long report page killed a whole chat turn in staging. The eyes tool captures with `fullPage: true`, Chrome happily rendered a bitmap past 8000 pixels, and the provider rejected the request with a 400 — "At least one of the image dimensions exceed max allowed size: 8000 pixels". The existing viewport fallback never fired, because it guards a Chrome refusal and Chrome did not refuse; the failure surfaced at the provider, where the capture code cannot see it. Scaling the picture down is not a fix either: the provider downscales every image to about 1568 pixels on the long side, thus even a legal 7000-pixel capture reaches the model compressed past legibility. The fix is slicing.

## What Changes

- `capturePage` (`src/lib/page-capture.ts`) measures the document height after the readiness wait. A short page keeps the one full-page shot. A taller page captures consecutive vertical slices of about two window heights each, in document order, up to a budget of six slices. A page taller than the budget covers truncates honestly: the coverage reports the captured pixels against the total. The Chrome-refusal degradation stays — a thrown capture retries once at the window, with the cause chained.
- `PageCapture` becomes multi-shot: `screenshots: [{ base64, range? }]` plus a coverage discriminant — `{ kind: "full" }`, `{ kind: "tiled", capturedPx, totalPx }`, or `{ kind: "viewport" }`.
- The tool-result picture convention becomes an ordered list. `withToolResultImages` attaches a list, `readToolResultImages` reads either shape as a list, and the loop encodes every image on the placement it already picked: `[text, ...files]` on the tool result, each picture into the deferred user-message collector in order, or one warn with the count on the drop. No new capability flag — a wire that declares a picture capability declares it for the list.
- The `examined` outcome of `examine_page` gains the coverage accounting and a `tiles` list (`{ index, fromY, toY }`) that mirrors the picture order, thus the model reads which rows each picture holds. The report-session prompt teaches the slices and the honest truncation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-verification`: the eyes-tool requirement gains the tiled capture, the slice budget, and the honest coverage accounting.
- `harness-agent-loop`: the tool-picture requirement generalizes to an ordered list of pictures under the same placement precedence.
- `report-session-agent`: the prompt obligations teach the sliced look and the unseen tail.

## Impact

- Affected code: `src/lib/page-capture.ts`, `src/tools/define-tool.ts`, `src/loop/run-agent.ts`, `src/tools/report-session/examine-page.ts`, `src/prompts/report-session.ts`, and their tests.
- `PageCapture` changes shape. The eyes tool is its one consumer; the old report path is gone.
- The single-image writer `withToolResultImage` stays, and the reader tolerates both shapes, thus no other tool moves.
