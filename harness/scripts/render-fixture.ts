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

import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ASSETS_DIR, DEPS_DIR, PAGE_ASSETS } from "../src/report-render/assets.js";
import { FIXTURE_DOCUMENT, FIXTURE_PROVENANCE, FIXTURE_VALUES } from "../src/report-render/fixture.js";
import { renderReportPage } from "../src/report-render/render.js";
import { resolvePageAssetFromInstallation } from "../src/report-render/asset-lookup.js";

// The provenance rides the render, thus the page carries the lineage stamp of each grounded block and the
// control beside each marker.
const rendered = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES, undefined, undefined, FIXTURE_PROVENANCE);
if (rendered.isErr()) {
    throw new Error(`The fixture did not render: ${JSON.stringify(rendered.error)}`);
}

const pageDir = join(tmpdir(), "inflexa-report-fixture");
const assetsDir = join(pageDir, ASSETS_DIR);
// Each manifest entry names a subpath under the deps directory, and the recursive make covers both levels.
await mkdir(join(assetsDir, DEPS_DIR), { recursive: true });
// The fixture stages what the preview stages, because one lookup answers for both. Thus a manifest entry
// that the preview resolves cannot be an entry that the fixture page misses.
for (const asset of PAGE_ASSETS) {
    await copyFile(resolvePageAssetFromInstallation(asset.specifier), join(assetsDir, asset.file));
}
// The rows of a table ride a data asset. Without the write the page opens with a failed script request,
// and the person sees a table card with no data behind it.
for (const asset of rendered.value.dataAssets) {
    await writeFile(join(assetsDir, asset.name), asset.bytes, "utf8");
}

const pagePath = join(pageDir, "index.html");
await writeFile(pagePath, rendered.value.html, "utf8");
console.log(pagePath);
