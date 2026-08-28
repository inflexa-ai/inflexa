/**
 * The shared runner of the golden-fixture tables.
 *
 * Each external-API schema gets one positive fixture, which carries the observed
 * absence encoding of its provider, and one `*.drift.json` twin, which carries one
 * genuine type break. The runner registers the same three assertions for each
 * case: the schema accepts the positive fixture, the mapped output holds, and the
 * schema rejects the twin.
 *
 * The reject assertion is the guard that cannot erode. A later widening that makes
 * the schema accept anything also makes the twin parse, thus the table fails.
 *
 * The runner reads the fixtures from disk at test time. As a result a fixture file
 * is raw evidence, and no import or build step stands between the payload of the
 * provider and the assertion.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export type { FixtureManifest, FixtureManifestEntry } from "./manifest.js";

const FIXTURES_DIR = fileURLToPath(new URL(".", import.meta.url));

/** One row of a fixture table. `S` is the schema under test. */
export interface FixtureCase<S extends z.ZodType> {
    /** The name of the schema under test, as the test output shows it. */
    name: string;
    /** The fixture directory of the provider, under `src/tools/lib/__fixtures__/`. */
    provider: string;
    /** The file name of the positive fixture, inside the provider directory. */
    fixture: string;
    /** The file name of the `*.drift.json` twin, inside the same directory. */
    drift: string;
    /** The schema under test. */
    schema: S;
    /**
     * The assertion over the parsed fixture. A client that maps the payload calls
     * its own mapper here and asserts the mapped record.
     */
    assertOutput?: (output: z.infer<S>) => void;
}

/**
 * A fixture case whose schema type is erased.
 *
 * One table mixes schemas of different shapes, thus the array element type cannot
 * carry the schema of each row. `fixtureCase` erases the row after it typechecks
 * the assertion against the real schema.
 */
export type ErasedFixtureCase = FixtureCase<z.ZodType>;

/**
 * Declare one row of a fixture table.
 *
 * The call site gets `assertOutput` typed as the output of its own schema. Write
 * each row through this function, and never through a bare object literal.
 */
export function fixtureCase<S extends z.ZodType>(testCase: FixtureCase<S>): ErasedFixtureCase {
    return testCase as unknown as ErasedFixtureCase;
}

/** Read one fixture file of a provider directory and parse it as JSON. */
export function readFixture(provider: string, file: string): unknown {
    return JSON.parse(readFileSync(join(FIXTURES_DIR, provider, file), "utf8")) as unknown;
}

/** Register the accept, map, and reject assertions for each row of a fixture table. */
export function runFixtureSuite(suiteName: string, cases: readonly ErasedFixtureCase[]): void {
    describe(suiteName, () => {
        for (const testCase of cases) {
            describe(testCase.name, () => {
                it("accepts the positive fixture", () => {
                    const parsed = testCase.schema.safeParse(readFixture(testCase.provider, testCase.fixture));
                    // The empty-array comparison reports each rejected path, thus a
                    // failure names the field instead of only "false".
                    expect(parsed.success ? [] : describeIssues(parsed.error)).toEqual([]);
                });

                const assertOutput = testCase.assertOutput;
                if (assertOutput) {
                    it("maps the positive fixture to the expected output", () => {
                        assertOutput(testCase.schema.parse(readFixture(testCase.provider, testCase.fixture)));
                    });
                }

                it("rejects the drift twin", () => {
                    const parsed = testCase.schema.safeParse(readFixture(testCase.provider, testCase.drift));
                    expect(parsed.success).toBe(false);
                });
            });
        }
    });
}

/** Render each issue of a rejection as `path: message`. */
function describeIssues(error: z.ZodError): string[] {
    return error.issues.map((issue) => {
        const path = issue.path.map((segment) => String(segment)).join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
    });
}
