## 1. The chart card and the geometry

- [x] 1.1 Replace the window-chrome markup of the chart view with the corner-accent card and the mono title line. Remove the badge.
- [x] 1.2 Remove the window-chrome rules, the dots, and the hover raise from `DESIGN_CSS`. Sweep each dead class rule with its emitter.

## 2. The layout and the wording

- [x] 2.1 Add the centered content column token, and make every block kind fill it. Remove the `72ch` prose cap.
- [x] 2.2 The footer reads `Powered by Inflexa`, and the navigation brand links to the Inflexa site.

## 3. The scrollspy and the appendix

- [x] 3.1 Add the scrollspy script beside the reveal script: an observer over the section anchors drives one active class on the matching link. Add the active-link rule.
- [x] 3.2 Rename the auto-generated list to "Data provenance", and style it as a muted appendix.

## 4. The gates

- [x] 4.1 Update and run the targeted render and view tests only.
- [x] 4.2 Run `bun run format:file` on the touched `src/` files, then `tsc -p tsconfig.json`.
- [x] 4.3 Re-render the proof document of the first session through the harness fixtures, and confirm the five items on the page.
