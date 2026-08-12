# Proposal: add-report-design-system

## Why

Issue #221 rebuilt report generation, and the new path renders a typed block document. But the page keeps only a partial copy of the old theme, thus a rendered report looks weak (#311). The page also pulls its runtime from a CDN at view time. Thus print fails without a network, and a frozen version decays when the CDN drops the pin.

## What Changes

- Port the visual identity of `templates/report-html` into the new renderer. The port covers the tokens, the components, and the page architecture.
- Give each of the eight block kinds a considered rendered form under that identity.
- Make the rendered page self-contained. Replace the Tailwind runtime with static CSS. Vendor the ECharts runtime and the two fonts.
- Repair the known render defects: the unregistered color tokens, the chart container with no height, and the dead style rules.
- Define how a person improves the design without an agent that writes markup.
- Give the rule that selects between a new block kind and a richer render of an existing kind.

## Capabilities

### New Capabilities

- `report-design-system`: the visual identity that a block document renders through. It covers the tokens, the typography, the per-kind components, the page architecture, the chart theme, the print form, and the evolution rule.

### Modified Capabilities

- `report-render`: the requirement "The page holds no local asset reference" changes. The page becomes self-contained, and it references no CDN at view time.

## Impact

- `harness/src/report-render/` holds the design source: `page.ts`, the views, and the chart theme.
- `harness/src/report-render/validity.test.ts` extends. The HTML gate and the CSS gate cover the new components.
- Vendored assets enter the package: ECharts 5.5.1, Space Grotesk, and IBM Plex Mono. The OFL license of each font permits the copy.
- The old path does not change. `templates/report-html`, `previews/`, and the Nunjucks renderer stay as they are.
- The block contract in `src/contracts/report-blocks.ts` does not change.
- The readiness sentinel of `lib/page-capture.ts` stays, thus `examine_page` works without a change.
