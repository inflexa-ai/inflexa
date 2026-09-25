/**
 * Render the figure gallery to a directory, and print the path of the page.
 *
 * A person runs this script after an edit of a figure module or of the theme. The script loads the gallery
 * tables, resolves the references of the gallery document, renders the page, and stages each manifest asset
 * and each data asset beside it. Thus the page opens in a browser with no network, and the person compares
 * each figure with the canonical design of its field.
 *
 * The output directory is a stable path under the system temp directory. Thus a second run overwrites the
 * same page, and no file lands inside the repository.
 *
 * The repository does not carry the gallery tables. Without them the script prints the command that rebuilds
 * them, `bun run gallery:data`, and exits with status 1.
 *
 * The script is a development tool. It sits outside `src/`, thus the build never emits it into `dist/`.
 */

import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ASSETS_DIR, DEPS_DIR, PAGE_ASSETS } from "../src/report-render/assets.js";
import { GALLERY_DATA_HINT, GALLERY_DOCUMENT, hasGalleryData, loadGallery } from "../src/report-render/gallery/gallery.js";
import { renderReportPage } from "../src/report-render/render.js";
import { resolvePageAssetFromInstallation } from "../src/report-render/asset-lookup.js";

if (!hasGalleryData()) {
    console.error(GALLERY_DATA_HINT);
    process.exit(1);
}
const loaded = await loadGallery();
if (loaded.isErr()) {
    throw new Error(`The gallery did not load: ${JSON.stringify(loaded.error)}`);
}
const rendered = await renderReportPage(GALLERY_DOCUMENT, loaded.value.values);
if (rendered.isErr()) {
    throw new Error(`The gallery did not render: ${JSON.stringify(rendered.error)}`);
}

const pageDir = join(tmpdir(), "inflexa-report-gallery");
const assetsDir = join(pageDir, ASSETS_DIR);
// The name of a data asset holds a hash of its content. A second run after an edit writes new names, thus the
// directory starts empty and no asset of an earlier run stays beside the page.
await rm(pageDir, { recursive: true, force: true });
await mkdir(join(assetsDir, DEPS_DIR), { recursive: true });
for (const asset of PAGE_ASSETS) {
    await copyFile(resolvePageAssetFromInstallation(asset.specifier), join(assetsDir, asset.file));
}
for (const asset of rendered.value.dataAssets) {
    await writeFile(join(assetsDir, asset.name), asset.bytes, "utf8");
}

const pagePath = join(pageDir, "index.html");
await writeFile(pagePath, rendered.value.html, "utf8");
console.log(pagePath);
