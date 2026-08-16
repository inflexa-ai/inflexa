/**
 * The asset manifest of the page.
 *
 * The page loads its chart runtime and its fonts from the sibling `assets/` directory. Thus each entry
 * names the staged file and the module specifier of its source. The caller resolves each specifier against
 * its own installation, and it copies the bytes beside the page.
 *
 * Each entry of the manifest names a file under `deps/`. Thus the shipped libraries and the shipped fonts
 * sit in one directory of their own, and the files that the report produced keep the root of the assets
 * directory. A reader of the directory then tells the two apart on sight, and the sweep of the stage governs
 * the report-side files alone.
 *
 * The module holds data alone. The renderer reads no file, thus the page stays a pure function of its
 * inputs.
 */

/** The directory of the staged assets, relative to the page. */
export const ASSETS_DIR = "assets";

/**
 * The directory of the shipped libraries and fonts, under the assets directory.
 *
 * The manifest, the skeleton, and the stage each spell the segment through this constant. Thus the tag of
 * the page, the file that the stage writes, and the set that the sweep keeps cannot disagree.
 */
export const DEPS_DIR = "deps";

/**
 * One staged asset. `file` is the path under the assets directory, and `specifier` is the module
 * specifier of the source file inside the installed package.
 */
export interface PageAsset {
    readonly file: string;
    readonly specifier: string;
}

/** The relative source of a staged asset. The page directory is self-contained, thus the source is `assets/<file>`. */
export function assetSource(asset: PageAsset): string {
    return `${ASSETS_DIR}/${asset.file}`;
}

/** The relative source of a staged file by its name. A page reference never spells the directory itself. */
export function stagedSource(file: string): string {
    return `${ASSETS_DIR}/${file}`;
}

/** The count of hash characters in a staged name. A staged file carries enough of the hash to be unique. */
const HASH_CHARS = 12;

/**
 * The staged name of the raw bytes of one table artifact: a hash head, then the basename of the path.
 *
 * The reader downloads the pinned file itself and never a re-serialization of it, thus the name must carry
 * the identity of those bytes. The hash head makes two artifacts of one basename two staged files, and the
 * basename keeps the downloaded file recognizable on the disk of the reader.
 *
 * The hash arrives as `algorithm:hex`, and neither the colon nor a path separator is safe in a file name.
 * The head takes the hex alone, and the basename takes each unsafe run as one dash.
 */
export function tableSidecarName(hash: string, path: string): string {
    const hex = hash.slice(hash.lastIndexOf(":") + 1).replace(/[^a-z0-9]+/gi, "");
    const base = path.slice(path.lastIndexOf("/") + 1).replace(/[^a-z0-9._-]+/gi, "-");
    return `${hex.slice(0, HASH_CHARS)}-${base}`;
}

/**
 * The staged name of the script of one derivation: a hash head, in the content-address style of a data
 * asset.
 *
 * The chain line of the appendix links this name, and the stage writes the script text under it. Both read
 * this one function, thus the link and the file cannot disagree. The head is the head that the chain line
 * shows, thus a reader compares the shown hash against the file name by sight.
 *
 * The extension is `.py`, because a session derivation runs its script through the Python interpreter of the
 * container.
 */
export function derivationScriptName(scriptHash: string): string {
    const hex = scriptHash.slice(scriptHash.lastIndexOf(":") + 1).replace(/[^a-z0-9]+/gi, "");
    return `d-${hex.slice(0, HASH_CHARS)}.py`;
}

/** The chart runtime. The page-side bootstrap reads the `echarts` global that this file declares. */
export const ECHARTS_ASSET: PageAsset = {
    file: `${DEPS_DIR}/echarts.min.js`,
    specifier: "echarts/dist/echarts.min.js",
};

/**
 * The grid runtime. The page-side bootstrap reads the `agGrid` global that this file declares.
 *
 * The entry names the browser bundle of the package. The package `exports` map publishes the module
 * entries alone, thus this specifier resolves as a path under the installed package directory.
 */
export const AG_GRID_ASSET: PageAsset = {
    file: `${DEPS_DIR}/ag-grid-community.min.js`,
    specifier: "ag-grid-community/dist/ag-grid-community.min.js",
};

/** The sans font. The file is the latin subset of the variable font, thus one file carries each weight. */
export const SANS_FONT_ASSET: PageAsset = {
    file: `${DEPS_DIR}/space-grotesk-latin-wght-normal.woff2`,
    specifier: "@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2",
};

/**
 * The mono font at weight 400, for the body of a data cell.
 *
 * Fontsource publishes no variable IBM Plex Mono, thus each weight is a separate file and a separate entry.
 * The identity uses four weights: 400 for a data cell, 500 for a tag, 600 for a table header and a badge,
 * and 700 for a metric value.
 */
export const MONO_FONT_400_ASSET: PageAsset = {
    file: `${DEPS_DIR}/ibm-plex-mono-latin-400-normal.woff2`,
    specifier: "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2",
};

/** The mono font at weight 500, for a tag and a stat-card label. */
export const MONO_FONT_500_ASSET: PageAsset = {
    file: `${DEPS_DIR}/ibm-plex-mono-latin-500-normal.woff2`,
    specifier: "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2",
};

/** The mono font at weight 600, for a table header, a section label, and the panel badge. */
export const MONO_FONT_600_ASSET: PageAsset = {
    file: `${DEPS_DIR}/ibm-plex-mono-latin-600-normal.woff2`,
    specifier: "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2",
};

/** The mono font at weight 700, for a metric value. */
export const MONO_FONT_700_ASSET: PageAsset = {
    file: `${DEPS_DIR}/ibm-plex-mono-latin-700-normal.woff2`,
    specifier: "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-700-normal.woff2",
};

/** Each asset that the caller stages beside the page. */
export const PAGE_ASSETS: readonly PageAsset[] = [
    ECHARTS_ASSET,
    AG_GRID_ASSET,
    SANS_FONT_ASSET,
    MONO_FONT_400_ASSET,
    MONO_FONT_500_ASSET,
    MONO_FONT_600_ASSET,
    MONO_FONT_700_ASSET,
];
