/**
 * The eyes seam: where a browser comes from for one look at a report page.
 *
 * The seam answers that one question, and it answers nothing else. It gives an endpoint for one scope, and
 * the harness keeps every page behavior: the `file://` navigation, the readiness wait, and the seen stamp.
 * Thus a host with a standing sidecar and a host that starts a browser for one look share one page
 * implementation.
 *
 * A realization must bound the life of what it provisions. A lease that no release ends must still end at
 * that bound. A process can die between the acquire and the release, thus no release of a caller prevents
 * every leak. The release of a caller is hygiene, and it is not the guarantee. This bound is the load-bearing
 * contract of the seam, and each new realization obeys it.
 *
 * The seam speaks the throw protocol, the same as the capture seam beside it. A caller that needs a typed
 * outcome guards the acquire and the release.
 */

import { hasBrowserUrl, type ChromeConfig } from "./chrome.js";

/**
 * What one acquire covers.
 *
 * A realization that starts a container mounts the workspace root at the identical host path, because the
 * page navigation reads a `file://` URL of the host tree. The caller resolves the root already, thus the
 * scope hands it over and a realization holds no second resolver.
 */
export interface EyesScope {
    readonly analysisId: string;
    readonly workspaceRoot: string;
}

/**
 * One acquired browser, and the end of the lease.
 *
 * `browserUrl` is the endpoint that a capture connects to. `release` ends the lease of the caller. The shape
 * binds no duration, thus one look and a longer interactive hold read the same.
 */
export interface EyesLease {
    readonly browserUrl: string;
    release(): Promise<void>;
}

/**
 * The eyes seam. One call gives one lease over one scope.
 *
 * The embedder binds a realization at its composition root. The harness reads this type alone, and it never
 * asks which realization answers.
 */
export type AcquireEyes = (scope: EyesScope) => Promise<EyesLease>;

/**
 * Make the static realization over a standing sidecar.
 *
 * Each look reads the configured endpoint, and the release does nothing, because the realization provisions
 * nothing. The sidecar stands outside this process. Thus the deployment that runs the sidecar owns its life,
 * and the no-leak bound of the seam holds with no work here.
 */
export function createStaticEyes(chrome: ChromeConfig): AcquireEyes {
    // A realization with no endpoint can only fail at the first look, and a look sits deep inside a model
    // turn. The refusal at construction moves the fault to the boot of the composition, where a programmer
    // reads it. `getBrowser` in `chrome.ts` refuses the same condition with a throw, thus one absent endpoint
    // gets one answer at both sites. The assembly constructs this realization behind `hasBrowserUrl` alone,
    // thus a composition that names no browser never reaches the refusal.
    if (!hasBrowserUrl(chrome)) {
        throw new Error("static eyes need a browser endpoint, and the chrome config names none");
    }
    const browserUrl = chrome.browserUrl;

    return async (_scope: EyesScope): Promise<EyesLease> => ({
        browserUrl,
        release: async () => {
            // The standing sidecar outlives every look, thus nothing ends here.
        },
    });
}
