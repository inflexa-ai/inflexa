/**
 * Stage one rendered report page into a directory.
 *
 * Both render scripts share the staging: the manifest assets ride from their installation paths, the data
 * assets land beside the page, and the page itself lands as `index.html`. Thus each staged page opens in a
 * browser with no network.
 */

import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolvePageAssetFromInstallation } from "../src/report-render/asset-lookup.js";
import { ASSETS_DIR, DEPS_DIR, PAGE_ASSETS } from "../src/report-render/assets.js";

export type RenderedPage = {
    readonly html: string;
    readonly dataAssets: ReadonlyArray<{ readonly name: string; readonly bytes: string }>;
};

export async function stageReportPage(pageDir: string, rendered: RenderedPage): Promise<string> {
    const assetsDir = join(pageDir, ASSETS_DIR);
    // Each manifest entry names a subpath under the deps directory, and the recursive make covers both levels.
    await mkdir(join(assetsDir, DEPS_DIR), { recursive: true });
    // One lookup answers for every staged page, thus an asset that one render resolves cannot be missing
    // from another.
    for (const asset of PAGE_ASSETS) {
        await copyFile(resolvePageAssetFromInstallation(asset.specifier), join(assetsDir, asset.file));
    }
    // The rows of a table ride a data asset. Without the write the page opens with a failed script request,
    // and the person sees a table card with no data behind it.
    for (const asset of rendered.dataAssets) {
        await writeFile(join(assetsDir, asset.name), asset.bytes, "utf8");
    }

    const pagePath = join(pageDir, "index.html");
    await writeFile(pagePath, rendered.html, "utf8");
    return pagePath;
}
