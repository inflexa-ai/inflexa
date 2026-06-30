import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { ResultAsync } from "neverthrow";
import type { FsError } from "./fs.ts";

/** SHA-256 hash a file by streaming its content. Returns the hex-encoded digest. */
export function sha256File(path: string): ResultAsync<string, FsError> {
    return ResultAsync.fromPromise(
        new Promise<string>((resolve, reject) => {
            const hash = createHash("sha256");
            const stream = createReadStream(path);
            stream.on("data", (chunk) => hash.update(chunk));
            stream.on("end", () => resolve(hash.digest("hex")));
            stream.on("error", reject);
        }),
        (cause): FsError => ({ type: "io_failed", op: "sha256File", cause }),
    );
}
