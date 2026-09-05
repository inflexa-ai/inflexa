/**
 * The environment match: the pins of a template against the versions of the
 * farm that the caller reports.
 *
 *   exact       every pinned package is present at the pinned version
 *   compatible  every pinned package is present, and each version shares the
 *               major and the minor number with its pin
 *   mismatch    a pinned package is absent, or a version differs beyond minor
 *   unknown     the caller reported no farm
 *
 * The match is a fact for the decision record. Phase 0 warns on a mismatch and
 * never blocks, because a rendered script that fails on a version difference
 * fails in the open in the sandbox.
 */

import type { EnvironmentPin } from "./types.js";

export type EnvironmentMatch = "exact" | "compatible" | "mismatch" | "unknown";

export interface FarmPackage {
    readonly name: string;
    readonly version: string;
}

export interface EnvironmentReport {
    readonly match: EnvironmentMatch;
    readonly pins: readonly (EnvironmentPin & { readonly farm?: string; readonly status: "exact" | "compatible" | "mismatch" | "absent" })[];
}

function majorMinor(version: string): string {
    const parts = version.split(/[.-]/);
    return `${parts[0] ?? ""}.${parts[1] ?? ""}`;
}

export function matchEnvironment(pins: readonly EnvironmentPin[], farm: readonly FarmPackage[] | undefined): EnvironmentReport {
    if (farm === undefined) return { match: "unknown", pins: pins.map((pin) => ({ ...pin, status: "absent" })) };
    const byName = new Map(farm.map((pkg) => [pkg.name.toLowerCase(), pkg.version]));
    const rows = pins.map((pin) => {
        const version = byName.get(pin.name.toLowerCase());
        if (version === undefined) return { ...pin, status: "absent" as const };
        if (version === pin.version) return { ...pin, farm: version, status: "exact" as const };
        if (majorMinor(version) === majorMinor(pin.version)) return { ...pin, farm: version, status: "compatible" as const };
        return { ...pin, farm: version, status: "mismatch" as const };
    });
    const match: EnvironmentMatch = rows.some((row) => row.status === "absent" || row.status === "mismatch")
        ? "mismatch"
        : rows.some((row) => row.status === "compatible")
          ? "compatible"
          : "exact";
    return { match, pins: rows };
}
