/**
 * Shared constants for the PharmGKB clinical-annotation API.
 *
 * PharmGKB is now ClinPGx, and `api.pharmgkb.org` no longer resolves. The
 * successor host serves the same paths, the same envelope, and the same field
 * names, thus only the host changes here.
 */

export const PHARMGKB_BASE = "https://api.clinpgx.org/v1/data";
export const PHARMGKB_HEADERS = { Accept: "application/json" } as const;
