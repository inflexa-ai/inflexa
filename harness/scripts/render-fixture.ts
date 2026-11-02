/**
 * Render the design fixture to a directory, and print the path of the page.
 *
 * A person runs this script after an edit of `design.ts` or of a view. The script writes the page and it
 * stages each manifest asset beside the page. Thus the page opens in a browser with no network, and the
 * person sees the design edit directly.
 *
 * The output directory is a stable path under the system temp directory. Thus a second run overwrites the
 * same page, and no file lands inside the repository.
 *
 * The script is a development tool. It sits outside `src/`, thus the build never emits it into `dist/`.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXTURE_DOCUMENT, FIXTURE_PROVENANCE, FIXTURE_VALUES } from "../src/report-render/fixture.js";
import { renderReportPage } from "../src/report-render/render.js";
import { stageReportPage } from "./stage-report-page.js";

// The provenance rides the render, thus the page carries the lineage stamp of each grounded block and the
// control beside each marker.
const rendered = await renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES, { provenance: FIXTURE_PROVENANCE });
if (rendered.isErr()) {
    throw new Error(`The fixture did not render: ${JSON.stringify(rendered.error)}`);
}

const pagePath = await stageReportPage(join(tmpdir(), "inflexa-report-fixture"), rendered.value);
console.log(pagePath);
