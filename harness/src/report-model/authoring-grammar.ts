/**
 * The block grammar that an agent writes and reads.
 *
 * The pinned snapshot owns the hash of each artifact reference. Thus an agent names the path alone, and the
 * land path stamps the hash from the snapshot entry at that path. This grammar is the contract grammar with
 * that one field dropped. The published input schema of a tool shows no hash, and a read of a block gives
 * none back. Thus an agent never sees a hash, and it never mistypes one.
 *
 * The grammar composes from the contract schemas, and it does not copy them. Each block keeps its own
 * fields, and only the reference-bearing field of a kind changes. Thus a new field of a block reaches this
 * grammar the moment that the contract declares it.
 *
 * The stored form stays the contract form. The stamp fills the hash before the draft grammar parses the
 * payload, thus the grounding and the resolution read the same pin as before.
 */

import { z } from "zod";

import {
    ChartBlockSchema,
    CitationBlockSchema,
    ClaimBlockSchema,
    FigureBlockSchema,
    MetricBlockSchema,
    TableBlockSchema,
    TextBlockSchema,
} from "../contracts/report-blocks.js";
import {
    ArtifactFileReferenceSchema,
    ArtifactTableReferenceSchema,
    ArtifactValueReferenceSchema,
    CitationReferenceSchema,
    DerivationReferenceSchema,
} from "../contracts/report-reference.js";

/** A reference to one scalar value inside an artifact, by the path of the artifact and a locator. */
const AuthoringValueReferenceSchema = ArtifactValueReferenceSchema.omit({ hash: true });

/** A reference to a whole table artifact, by the path of the artifact. */
const AuthoringTableReferenceSchema = ArtifactTableReferenceSchema.omit({ hash: true });

/** A reference to a whole artifact file, by the path of the artifact. */
const AuthoringFileReferenceSchema = ArtifactFileReferenceSchema.omit({ hash: true });

/** A reference to a value computed from two scalar references. Each input names a path and no hash. */
const AuthoringDerivationReferenceSchema = DerivationReferenceSchema.extend({
    inputs: z
        .array(AuthoringValueReferenceSchema)
        .length(2)
        .describe("The two input references. Each operation takes exactly two, and each one must resolve to a scalar."),
});

/** The full reference union of the authoring surface. A citation names an external id, thus it pins no artifact. */
const AuthoringReferenceSchema = z.discriminatedUnion("kind", [
    AuthoringValueReferenceSchema,
    AuthoringTableReferenceSchema,
    AuthoringFileReferenceSchema,
    AuthoringDerivationReferenceSchema,
    CitationReferenceSchema,
]);

/** The references of the authoring surface that resolve to one scalar value. */
const AuthoringScalarReferenceSchema = z.discriminatedUnion("kind", [AuthoringValueReferenceSchema, AuthoringDerivationReferenceSchema]);

/**
 * The chart block of the authoring surface.
 *
 * A chart carries a rule over its own fields, and a schema with a rule refuses a replacement of one field.
 * Thus this schema spreads the fields of the contract chart, and it replaces the binding. The rule itself
 * stays out: the core parses each payload with the draft grammar, and that grammar carries the rule. This
 * schema publishes the shape, and it types the read.
 */
const AuthoringChartBlockSchema = z.strictObject({
    ...ChartBlockSchema.shape,
    binding: AuthoringTableReferenceSchema.describe("The whole-table artifact to plot."),
});

/**
 * The seven atoms of the authoring surface.
 *
 * A text block and a citation block bind no artifact, thus each one is the contract schema itself. The five
 * others replace the one field that carries a pin.
 */
const AUTHORING_ATOM_SCHEMAS = [
    TextBlockSchema,
    ClaimBlockSchema.extend({ bindings: z.array(AuthoringReferenceSchema).min(1).describe("The evidence that justifies the claim.") }),
    MetricBlockSchema.extend({ value: AuthoringScalarReferenceSchema.describe("The one scalar reference that gives the metric value.") }),
    TableBlockSchema.extend({ binding: AuthoringTableReferenceSchema.describe("The whole-table artifact to render.") }),
    AuthoringChartBlockSchema,
    FigureBlockSchema.extend({ binding: AuthoringFileReferenceSchema.describe("The image artifact. It pins the whole file, and the path names it.") }),
    CitationBlockSchema,
] as const;

/**
 * The section shape as a plain type. TypeScript cannot infer the block tree through the union cycle, thus
 * the recursive members carry an explicit type.
 */
export interface AuthoringSectionBlock {
    kind: "section";
    id: string;
    title: string;
    blocks: AuthoringBlock[];
}

/** One block of any kind except a section, as an agent writes it and reads it. */
export type AuthoringAtomBlock = z.infer<(typeof AUTHORING_ATOM_SCHEMAS)[number]>;

/** One block of any of the eight kinds, as an agent writes it and reads it. */
export type AuthoringBlock = AuthoringAtomBlock | AuthoringSectionBlock;

/** A section of the authoring surface permits zero child blocks, exactly as a draft section does. */
const AuthoringSectionBlockSchema = z.strictObject({
    kind: z.literal("section"),
    id: z.string().min(1),
    title: z.string(),
    blocks: z.lazy(() => z.array(AuthoringBlockSchema)),
});

/** The block union of the authoring surface. The annotation gives the recursive members a stable type. */
export const AuthoringBlockSchema: z.ZodType<AuthoringBlock> = z.discriminatedUnion("kind", [AuthoringSectionBlockSchema, ...AUTHORING_ATOM_SCHEMAS]);
