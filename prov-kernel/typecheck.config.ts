import { typecheck } from "@inflexa-ai/typecheck";

export default typecheck({
    overrides: [
        {
            // A Result that flows into `unwrapOrThrow(...)` IS consumed: the name is
            // reserved by convention across the Inflexa packages for the documented
            // Result→throw bridge at boundaries whose failure protocol is an exception.
            files: ["src/**"],
            rules: { "must-use-result": ["error", { consumers: ["unwrapOrThrow"] }] },
        },
    ],
});
