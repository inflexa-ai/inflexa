import { typecheck } from "@inflexa-ai/typecheck";

export default typecheck({
    overrides: [
        {
            // A Result that flows into one of these calls IS consumed:
            // - `fromCatalogStart` (src/server/routes/store.ts) takes the Result of a catalog
            //   transfer start and `.match`es it into the wire view.
            // - `readImageSbom` (src/modules/sbom/sbom.ts) takes the Result of the container
            //   runtime and checks `isErr()` itself before it reads the runtime.
            // - `awaitOk` (src/test_support/result.ts) awaits a call in a test and gives its ok
            //   value. An err throws, so a call through it states that the call succeeded.
            files: ["src/**"],
            rules: {
                "must-use-result": ["error", { consumers: ["fromCatalogStart", "readImageSbom", "awaitOk"] }],
            },
        },
    ],
});
