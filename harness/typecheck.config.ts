import { typecheck } from "@inflexa-ai/typecheck";

export default typecheck({
    overrides: [
        {
            // A Result that flows into one of these calls IS consumed: each name is
            // reserved by convention across the Inflexa packages for its helper —
            // `unwrapOrThrow` is the documented Result→throw bridge for boundaries
            // whose failure protocol is an exception (above all the DBOS step edge,
            // where durability records a step as failed ONLY on a thrown exception,
            // see src/lib/result.ts house rule 3 and src/loop/run-step.ts
            // `resultStep`); `passGate` forwards the Result of a gate as its own
            // Result; `deliverNotice` consumes the Result of a notice and logs its
            // err; `keepSuspendingRefusal` forwards the refusal of a spawn as its
            // own Result and throws each other failure through `unwrapOrThrow`.
            files: ["src/**"],
            rules: {
                "must-use-result": [
                    "error",
                    { consumers: ["unwrapOrThrow", "passGate", "deliverNotice", "keepSuspendingRefusal"] },
                ],
            },
        },
        {
            // A floating awaited `Promise<Result>` was invisible to the previous lint
            // rule (its visitor missed the promise wrapper), so the tests that drop the
            // Result and assert side effects were invisible to it. This command closes
            // that blind spot with 77 reports on main, 76 of them test drops. Turned on
            // in tests by a child of #607, where each test asserts the Result instead
            // of dropping it.
            files: ["**/*.test.{ts,tsx}"],
            rules: { "must-use-result": "off" },
        },
    ],
});
