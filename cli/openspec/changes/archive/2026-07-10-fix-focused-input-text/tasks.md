## 1. Fix and pin

- [x] 1.1 Add `focusedTextColor={props.busy ? theme().fgMuted : theme().fg}` to the `<textarea>` in `src/tui/components/text_area.tsx`, with a why-comment on the focused/unfocused split
- [x] 1.2 Add the same prop to the `<input>` in `src/tui/components/text_input.tsx` (`InputRenderable` inherits the split from `TextareaRenderable`)
- [x] 1.3 Regression render test: under `github-light`, a focused `TextArea` and a focused `TextInput` with typed text render the text spans in the theme `fg` (not `#ffffff`), via the `captureSpans()` idiom from `theme_contrast.render.test.tsx`
- [x] 1.4 Gate: `bun run typecheck`, `bun run lint`, targeted `bun test` files green; `bun run format:file` on touched src/ files
