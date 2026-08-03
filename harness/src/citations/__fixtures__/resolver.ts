import type { CitationResolver } from "../types.js";

/** Test-only resolver for construction paths that do not execute citation tools. */
export const unusedCitationResolver: CitationResolver = {
    async resolveOne() {
        throw new Error("unusedCitationResolver.resolveOne was unexpectedly called");
    },
    async resolveMany() {
        throw new Error("unusedCitationResolver.resolveMany was unexpectedly called");
    },
};
