import type { CitationResolver } from "../types.js";

/** Test-only resolver for construction paths that do not execute citation tools. */
export const unusedCitationResolver: CitationResolver = {
    resolveOne() {
        return Promise.reject(new Error("unusedCitationResolver.resolveOne was unexpectedly called"));
    },
    resolveMany() {
        return Promise.reject(new Error("unusedCitationResolver.resolveMany was unexpectedly called"));
    },
};
