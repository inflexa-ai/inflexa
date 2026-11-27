import { describe, expect, it } from "bun:test";

import { stagedAssetBytes } from "../assets.js";

const text = (bytes: Buffer): string => bytes.toString("utf8");
const bytesOf = (value: string): Buffer => Buffer.from(value, "utf8");

describe("stagedAssetBytes", () => {
    it("removes the source map link of a script, and keeps each other line", () => {
        const source = "(()=>{})();\n\n//# debugId=C99B7F36\n//# sourceMappingURL=tsprov.min.js.map\n";

        expect(text(stagedAssetBytes("deps/tsprov.min.js", bytesOf(source)))).toBe("(()=>{})();\n\n//# debugId=C99B7F36\n");
    });

    it("removes a source map link on the last line with no line end", () => {
        expect(text(stagedAssetBytes("deps/a.min.js", bytesOf("a();\n//# sourceMappingURL=a.min.js.map")))).toBe("a();\n");
    });

    it("keeps a script with no source map link as it is", () => {
        const source = bytesOf("echarts();\n");

        expect(stagedAssetBytes("deps/echarts.min.js", source)).toBe(source);
    });

    it("keeps a file that is not a script as it is, also when its bytes contain the text of a link", () => {
        const source = bytesOf("font\n//# sourceMappingURL=x.map\n");

        expect(stagedAssetBytes("deps/font.woff2", source)).toBe(source);
    });
});
