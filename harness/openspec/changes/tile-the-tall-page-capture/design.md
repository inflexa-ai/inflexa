# Design: tile-the-tall-page-capture

## Context

`capturePage` gave one full-page shot, with one retry at the window when Chrome refused the bitmap. The provider path holds two constraints that the capture could not see: a hard cap of 8000 pixels per dimension that rejects the whole request, and a downscale to about 1568 pixels on the long side that compresses a tall legal picture past legibility. A single-shot capture of a long report page therefore either kills the turn or blinds the model. The loop carried at most one picture per tool result, thus slicing needs the encoding to generalize first.

## Decisions

### D1: The tile height is two window heights, and it is also the single-shot bound

One constant, `TILE_HEIGHT_PX = 2 * VIEWPORT_HEIGHT` (1800). A slice of that height downscales to about 1568 pixels with the text still readable; a taller slice does not. The same number bounds the single-shot arm: a page at the bound or under survives the downscale whole, thus it costs one picture instead of two.

### D2: The budget is six slices, and the truncation is honest

`MAX_TILES = 6` bounds what one look costs the context — six pictures cover 10800 pixels, which holds every report page seen so far. A taller page truncates, and the coverage carries `capturedPx` against `totalPx`. The alternative — silently dropping the tail — would let the agent judge a page it did not see, and the prompt could not warn it.

### D3: The coverage is a discriminated union on the capture result

`{ kind: "full" }`, `{ kind: "tiled", capturedPx, totalPx }`, `{ kind: "viewport" }`. The accounting fields exist only on the arm that can truncate, thus a consumer cannot read a stale count off a full look. Each slice carries its `range` (`fromY`, `toY`), and the eyes tool mirrors those ranges as `tiles` on the JSON, in picture order.

### D4: The picture convention is a list, read through one seam

`readToolResultImages` returns an ordered list, and the one-image shape reads as a list of one. The single-image writer stays, thus the existing call sites and any cached values keep their meaning. The loop encodes the list on the placement it already picked; no `imagesToolResults` flag exists, because every supported wire that renders one image block in a place renders several.

### D5: The Chrome-refusal arm wraps both shapes

A thrown full-page shot and a thrown slice degrade the same way: one retry at the window, cause chained on a second throw. The tall page that reaches the tiled arm is exactly the page most likely to strain the compositor, thus the arm must cover it.

### D6: The measure failure reads as a short page

`document.documentElement.scrollHeight` is measured once after the settle. A page that refuses the measure captures as one full-page shot, thus a broken measure degrades to yesterday's behavior instead of a dead look.

## Risks / Trade-offs

- A truncated look does not see the tail of a page past 10800 pixels. The coverage names it, the prompt teaches it, and the agent judges only what it saw.
- Slice seams can cut a block in half. Consecutive slices share no overlap, thus a fault on the seam line appears split across two pictures; the tiles list gives the model the rows to stitch the two views.
- Six full-width PNG slices cost more context than one downscaled picture. That cost is the point: the model gets pixels it can read.
