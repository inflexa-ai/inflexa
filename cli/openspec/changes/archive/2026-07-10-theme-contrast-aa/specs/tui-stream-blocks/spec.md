## ADDED Requirements

### Requirement: Embedded opentui renderables receive themed colors

Every opentui renderable a block embeds that can paint text or color (`<code>`, `<diff>`, `<markdown>`) SHALL receive its colors from the active theme at the call site; relying on an opentui built-in default color (default foreground `#FFFFFF`, diff bands `#1a4d1a`/`#4d1a1a`, line numbers `#888888`, signs `#22c55e`/`#ef4444`) is a violation. Concretely: `<code>` SHALL receive `fg={theme().fg}` in addition to `syntaxStyle` (with zero tree-sitter highlights, `CodeRenderable` paints via `textBuffer.setText()` using the renderable's own default foreground, bypassing the syntax-style `"default"` scope — the prop is not redundant); `<diff>` SHALL receive `fg`, `syntaxStyle`, `addedBg={theme().diffAddedBg}`, `removedBg={theme().diffRemovedBg}`, `addedSignColor={theme().success}`, `removedSignColor={theme().error}`, and `lineNumberFg={theme().fgMuted}`; `<markdown>` SHALL receive `fg` and `syntaxStyle` (its pipe-table cells are covered by the syntax style's `"default"` scope, since opentui does not forward `fg` to its table child, and the chrome it draws itself — blockquote bars, horizontal rules, and pipe-table frames — is covered by the `"conceal"` scope).

One opentui default is out of the embedder's reach and is a **known exception**: when `<diff>` fails to parse a patch it renders its own error line with a hardcoded `#ef4444`, on a private renderable with no option to override it. The requirement above therefore governs every successfully-parsed diff; a malformed patch may show that one unthemed line. Closing it would require reaching into a private renderable or re-implementing patch parsing (a new dependency), neither of which is warranted for an error path.

#### Scenario: Tool results are readable in light themes

- **WHEN** a tool result (e.g. a data-profile report with plain-text data rows) renders in `ToolBlock` under a light theme
- **THEN** un-highlighted result text renders in the theme's `fg` against the block's background at ≥4.5:1 — never white-on-light

#### Scenario: Diff blocks are themed in both modes

- **WHEN** a `DiffBlock` renders a well-formed patch under any built-in theme
- **THEN** context lines use the theme's `fg`, added/removed row bands use `diffAddedBg`/`diffRemovedBg`, signs use `success`/`error`, and line numbers use `fgMuted` — no opentui default color is visible in either mode

#### Scenario: A malformed patch may show the one unthemed line

- **WHEN** `<diff>` cannot parse the patch it was given
- **THEN** it renders its own error line in opentui's hardcoded `#ef4444`, which the embedder cannot override — the single documented exception to this requirement

#### Scenario: Theme switch recolors embedded renderables

- **WHEN** the active theme changes while a tool result or diff is on screen
- **THEN** the embedded renderable's colors follow the new theme on the next frame (the props read `theme()` in a tracking scope)
