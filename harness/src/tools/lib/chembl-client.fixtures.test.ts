import { expect } from "bun:test";

import { fixtureCase, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import {
    ActivitiesResponseSchema,
    CompoundsResponseSchema,
    DrugIndicationsResponseSchema,
    MechanismsResponseSchema,
    MoleculeSearchResponseSchema,
    MoleculeStructuresResponseSchema,
    TargetSearchResponseSchema,
} from "./chembl-client.js";

runFixtureSuite("chembl golden fixtures", [
    fixtureCase({
        name: "MoleculeSearchResponseSchema — an approved molecule",
        provider: "chembl",
        fixture: "molecule-search-imatinib.json",
        drift: "molecule-search-imatinib.drift.json",
        schema: MoleculeSearchResponseSchema,
        assertOutput: (response) => {
            const imatinib = response.molecules?.[0];
            // ChEMBL serves `max_phase` as the string "4.0", thus the parsed value
            // proves the wire-number read.
            expect(imatinib?.max_phase).toBe(4);
            expect(imatinib?.pref_name).toBe("IMATINIB");
            expect(imatinib?.molecule_type).toBe("Small molecule");
            expect(imatinib?.first_approval).toBe(2001);
        },
    }),
    fixtureCase({
        name: "MoleculeSearchResponseSchema — an unnamed molecule",
        provider: "chembl",
        fixture: "molecule-pref-name-isnull.json",
        drift: "molecule-pref-name-isnull.drift.json",
        schema: MoleculeSearchResponseSchema,
        assertOutput: (response) => {
            expect(response.molecules).toHaveLength(2);
            expect(response.molecules?.[0]?.pref_name).toBeNull();
            expect(response.molecules?.[0]?.max_phase).toBeNull();
        },
    }),
    fixtureCase({
        name: "CompoundsResponseSchema — a small molecule and an antibody",
        provider: "chembl",
        fixture: "molecule-set-aspirin-trastuzumab.json",
        drift: "molecule-set-aspirin-trastuzumab.drift.json",
        schema: CompoundsResponseSchema,
        assertOutput: (response) => {
            const [aspirin, trastuzumab] = response.molecules ?? [];
            expect(aspirin?.chemblId).toBe("CHEMBL25");
            // The formula comes from the wire key `full_molformula`.
            expect(aspirin?.molecularFormula).toBe("C9H8O4");
            expect(aspirin?.canonicalSmiles).toBe("CC(=O)Oc1ccccc1C(=O)O");
            expect(aspirin?.molecularWeight).toBe(180.16);
            expect(aspirin?.alogp).toBe(1.31);
            // An antibody carries an explicit null for both blocks.
            expect(trastuzumab?.chemblId).toBe("CHEMBL1201585");
            expect(trastuzumab?.canonicalSmiles).toBeNull();
            expect(trastuzumab?.molecularFormula).toBeNull();
            expect(trastuzumab?.molecularWeight).toBeNull();
        },
    }),
    fixtureCase({
        name: "ActivitiesResponseSchema — an activity with no units",
        provider: "chembl",
        fixture: "activity-standard-units-isnull.json",
        drift: "activity-standard-units-isnull.drift.json",
        schema: ActivitiesResponseSchema,
        assertOutput: (response) => {
            const activity = response.activities?.[0];
            expect(activity?.standard_units).toBeNull();
            expect(activity?.standard_value).toBe(1.8);
            expect(activity?.pchembl_value).toBeNull();
            expect(activity?.molecule_chembl_id).toBe("CHEMBL295054");
        },
    }),
    fixtureCase({
        name: "MechanismsResponseSchema — a mechanism with no action type",
        provider: "chembl",
        fixture: "mechanism-action-type-isnull.json",
        drift: "mechanism-action-type-isnull.drift.json",
        schema: MechanismsResponseSchema,
        assertOutput: (response) => {
            const mechanism = response.mechanisms?.[0];
            expect(mechanism?.action_type).toBeNull();
            expect(mechanism?.target_chembl_id).toBeNull();
            expect(mechanism?.molecule_chembl_id).toBe("CHEMBL2021423");
        },
    }),
    fixtureCase({
        name: "TargetSearchResponseSchema — a target with no organism",
        provider: "chembl",
        fixture: "target-organism-isnull.json",
        drift: "target-organism-isnull.drift.json",
        schema: TargetSearchResponseSchema,
        assertOutput: (response) => {
            expect(response.targets?.[0]?.organism).toBeNull();
            expect(response.targets?.[0]?.target_type).toBe("NON-MOLECULAR");
        },
    }),
    fixtureCase({
        name: "DrugIndicationsResponseSchema — the melanoma indications",
        provider: "chembl",
        fixture: "drug-indication-melanoma.json",
        drift: "drug-indication-melanoma.drift.json",
        schema: DrugIndicationsResponseSchema,
        assertOutput: (response) => {
            const indication = response.drug_indications?.[0];
            expect(indication?.mesh_heading).toBe("Melanoma");
            expect(indication?.molecule_chembl_id).toBe("CHEMBL1229517");
            // `max_phase_for_ind` is a decimal, thus the wire value is the string "4.0".
            expect(indication?.max_phase_for_ind).toBe(4);
        },
    }),
    fixtureCase({
        name: "MoleculeStructuresResponseSchema — an antibody with no structures",
        provider: "chembl",
        fixture: "molecule-detail-trastuzumab.json",
        drift: "molecule-detail-trastuzumab.drift.json",
        schema: MoleculeStructuresResponseSchema,
        assertOutput: (response) => {
            expect(response.molecule_structures).toBeNull();
        },
    }),
]);
