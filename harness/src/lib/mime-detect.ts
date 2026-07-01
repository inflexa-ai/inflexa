/**
 * Mime-type detection for artifact registration.
 *
 * Registration payloads sent to the storage backend carry a `mimeType` per file. The storage backend
 * persists it on the artifact row and uses it as the S3 object's
 * `Content-Type` when the artifact is later synced — without it, S3 stores
 * `application/octet-stream` and downloads serve as opaque binary regardless
 * of file extension.
 *
 * The `mime` package's mime-db backing doesn't include a few science-domain
 * extensions (`.py`, `.R`, `.Rmd`, `.RData`, `.rds`) that browsers populate
 * in `File.type` from their bundled tables, so we extend a custom Mime
 * instance with those cases. Returned types align with the frontend's browser-side
 * detection so a Python script uploaded directly and one synced from a
 * sandbox both end up with the same `text/x-python`.
 */

import { Mime } from "mime";
import standard from "mime/types/standard.js";
import other from "mime/types/other.js";

const mime = new Mime(standard, other, {
    "text/x-python": ["py"],
    "text/x-r-source": ["R", "r"],
    "text/x-r-markdown": ["Rmd", "rmd"],
    "application/x-rdata": ["RData", "Rdata", "rds"],
});

const FALLBACK = "application/octet-stream";

export function detectMimeType(pathOrFilename: string): string {
    return mime.getType(pathOrFilename) ?? FALLBACK;
}
