/**
 * Every threshold the detected-set pipeline turns on, in one place.
 *
 * These are corpus-tuned numbers, not derivations: they exist as named constants so
 * that retuning is one edit and one diff, and so that a test can pin the behaviour a
 * given number buys rather than pinning the number.
 */

/** Sibling directories merge when their name-template signatures agree this well. */
export const FINE_SIMILARITY = 0.7;

/** The weaker agreement that suffices once two directories are already skeleton-kin. */
export const COARSE_SIMILARITY = 0.5;

/** A small directory whose signature is almost wholly contained in a larger one joins it. */
export const CONTAINMENT_SIMILARITY = 0.9;

/** Signature keys retained per directory. A wide tree needs no more to compare by. */
export const MAX_SIGNATURE_KEYS = 400;

/** Residual singletons a shared literal prefix must cover before it earns a set. */
export const MIN_PREFIX_SET_MEMBERS = 3;

/**
 * Singletons of one token-kind sequence that collapse into one set.
 *
 * The description-length trade: one template for the family costs less than one
 * template per file, but only once the family is large enough to pay for the
 * generality it loses.
 */
export const MIN_FAMILY_SET_MEMBERS = 4;

/** Residual files a cross-directory catch-all must cover before it earns a set. */
export const MIN_CATCH_ALL_MEMBERS = 2;

/** Sets one directory context may report before its tail folds into the catch-all. */
export const MAX_SETS_PER_CONTEXT = 12;

export const MIN_OPAQUE_ID_LENGTH = 16;
export const MIN_OPAQUE_ID_CHAR_CLASSES = 3;

/** Above this separator density a token is snake_case prose, not machine-issued. */
export const MAX_OPAQUE_ID_SEPARATOR_FRACTION = 0.12;

/** Mean length of a token's letter and digit runs. Random material fragments; words do not. */
export const MAX_OPAQUE_ID_MEAN_RUN = 3.5;

export const MIN_OPAQUE_ID_DIGIT_FRACTION = 0.15;

/** Case flips inside letter runs, decisive on their own — human names carry almost none. */
export const MIN_OPAQUE_ID_CASE_FLIPS = 4;
export const OPAQUE_ID_CASE_FLIP_DIVISOR = 6;

/** Dotted suffix tokens longer than this are stem material whatever the format table says. */
export const MAX_SUFFIX_TOKEN_LENGTH = 7;

/** A recovered literal affix shorter than this is dropped: stripping it would make the value sample lie. */
export const MIN_AFFIX_LENGTH = 2;

/** Values reported per slot. The sample is the agent's decision material, and it is bounded. */
export const MAX_SLOT_SAMPLE_VALUES = 12;

export const MAX_EXAMPLE_PATHS = 3;
export const MAX_QUARANTINE_SAMPLE = 12;
export const MAX_LEFTOVER_SAMPLE = 25;
export const MAX_INCOMPLETE_SAMPLE = 10;

/** Members whose directory token matches their stem token before the two are called one identity slot. */
export const IDENTITY_CROSS_CHECK_RATIO = 0.9;

/** Below this length a containment match between two tokens is coincidence, not identity. */
export const MIN_IDENTITY_TOKEN_LENGTH = 8;

/** Share of a set's members that must carry a companion suffix for it to count as expected. */
export const EXPECTED_COMPANION_SHARE = 0.5;
