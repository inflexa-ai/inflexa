import { expect } from "bun:test";

import { fixtureCase, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import { ReferralFileSchema } from "./ema-client.js";

runFixtureSuite("ema golden fixtures", [
    fixtureCase({
        name: "ReferralFileSchema — the referrals catalogue",
        provider: "ema",
        fixture: "referrals-catalogue.json",
        drift: "referrals-catalogue.drift.json",
        schema: ReferralFileSchema,
        assertOutput: (file) => {
            const rows = file.data!;
            expect(rows).toHaveLength(5);

            // Absence is the empty string, never a null and never an omission.
            expect(rows[0]!.associatedMedicinesNationally).toEqual([]);
            expect(rows[0]!.pracRecommendationDate).toBe("");

            // `safety_referral` is exactly "No" or "Yes".
            expect(rows[0]!.safetyReferral).toBe(false);
            expect(rows[1]!.safetyReferral).toBe(true);

            // The semicolon is the one separator.
            expect(rows[2]!.associatedMedicinesCentrally).toEqual(["Vectra 3D", "Melovem"]);

            // A comma belongs to the name of the medicine.
            expect(rows[3]!.associatedMedicinesNationally).toEqual(["Lidocaïne / Prilocaïne 5% Focus, Crème"]);
            expect(rows[4]!.associatedMedicinesNationally).toEqual(["Latanoprost Pharmacia & Upjohn", "Xalatan 50 mikrogramov/ml kaplijice za oko, raztopina"]);
        },
    }),
]);
