## Context

The identity lives in one design source (`report-render/design.ts`), the page scripts live in `page.ts`, and the views emit the markup. The chart panel carries `window-chrome` rules with dots, a hover raise, and a `CORTEX` badge (`views/chart-view.tsx`). The footer names the engine (`views/page-view.tsx`). The prose measure caps at `72ch` inside a `1600px` container, thus a prose section shows a dead right band.

## Goals / Non-Goals

- Goal: the page reads as one centered document with the Inflexa identity, and the navigation tracks the reader.
- Non-goal: a contract change. Every item lands in the design source, the page scripts, and the views.
- Non-goal: a new dependency. The scrollspy is a plain observer in the page script.

## Decisions

- **The scrollspy is a second small script beside the reveal script.** An `IntersectionObserver` over the section anchors drives one active class on the matching navigation link. The observer picks the section nearest the top through a negative bottom root margin, thus one link is active at a time. A browser with no observer keeps the plain links, because the spy is decoration.
- **The chart card joins the identity.** The chart renders in the square corner-accent card, with the mono title line of the table component and the fixed-height chart body. The `window-chrome` rules, the dots, the hover raise, and the badge leave the design source. Thus the geometric rule loses its one rounded exception, and every data card reads the same.
- **The centered column is a new content width.** A `--content-max` token (about `1100px`) centers inside the container, and every block kind fills it. The `72ch` cap on the prose goes, thus prose, tables, and charts share one width and no half-empty band remains.
- **The identity wording is three strings.** The badge goes with the chrome. The footer reads `Powered by Inflexa`. The navigation brand becomes a link to `https://inflexa.ai/`, and it is the one external reference of the page: a link costs no request, thus the page still stands alone.
- **The provenance appendix is a rename and a tone.** The auto-generated list takes the title "Data provenance" and the muted appendix styling. The literature section is citation blocks, and it stays separate.

## Risks / Trade-offs

- [A dead class rule after the chrome removal] → the design source invariant stands: each class rule matches an emitter. The removal sweeps the rules and the emitters together, and the render tests hold the pair.
- [The scrollspy fights the reveal script] → the two observers read different targets, and neither writes what the other reads.

## Open Questions

None.
