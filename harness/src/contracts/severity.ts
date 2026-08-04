/**
 * The severity scale shared by the curated safety panel and the dossier's
 * own liability rows.
 *
 * One scale, so a panel-derived severity and a dossier-asserted one mean the
 * same thing and can be compared without a translation table.
 */

import { z } from "zod";

export const SEVERITIES = ["high", "medium", "low"] as const;

export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = (typeof SEVERITIES)[number];
