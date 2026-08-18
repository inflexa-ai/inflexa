// The first run materializes the skills tree and the report page assets that the
// binary embeds. A release build ships those trees packed inside the executable (see scripts/build.ts +
// content-pack.ts); on boot this extracts them to the hash-keyed dir under env.contentDir that config.ts
// already resolves skillsDir to, so the harness — which reads the skills tree as a plain
// directory tree off disk — finds it. See the content-assets and harness-runtime specs. The assets
// directory has no entry in config.ts. The boot binds the page-asset lookup over the return value of the
// extract, thus no other code derives that path.
//
// This module is reached ONLY through runtime.ts's release-gated `await import("./content.ts")`. That
// gate, plus the fact that the embedded-archive import below only resolves when the module actually
// loads, is what keeps `cli/content.pack` (which exists solely as a build artifact) out of a dev run's
// module graph — a dev checkout has no such file, and a dev run resolves the skills to the repo
// tree instead. Verified empirically: an UNgated top-level asset import would demand the file on disk
// even in dev.
//
// This module binds the three inputs of the extract, and it holds nothing else. The algorithm is in
// content_extract.ts, which a test process can load.
import { type Result } from "neverthrow";

import { env } from "../../lib/env.ts";

import { extractContent, type ContentDirs, type ContentError } from "./content_extract.ts";

// Bun's file loader resolves this to a path STRING — a real disk path in dev, a /$bunfs/root/... path in
// a compiled binary — and embeds the bytes into the executable. The extract reads that path on its cold
// path alone, thus a warm boot pays nothing for it.
import CONTENT_PACK_PATH from "../../../content.pack" with { type: "file" };

/**
 * Extract the embedded archive to `<contentDir>/<contentHash>/{skills,assets}` and return those dirs.
 *
 * Release-only: the sole caller (runtime.ts) gates on `env.isDevelopment`, so a dev run never reaches here.
 * `env` freezes each read of `process.env` at import, thus the two frozen values and the embedded path bind
 * here, over an extract that takes them as parameters.
 */
export function ensureBundledContent(): Result<ContentDirs, ContentError> {
    return extractContent({ archivePath: CONTENT_PACK_PATH, contentDir: env.contentDir, contentHash: env.contentHash });
}
