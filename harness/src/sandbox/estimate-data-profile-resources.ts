import type { ResourceSpec } from "../config/resource-limits.js";

/**
 * The size of the profiler sandbox. It does not depend on the input bytes: the profiler reads headers
 * and container footers, and the inspection of one example file for each group, never a whole file.
 * A size from the bytes asked for about 202 GB of memory for one 100 GB BAM. 4 GB holds the Python and
 * R runtimes, a decoder that opens a footer-indexed container, and a pandas read of a header block.
 */
export const DATA_PROFILE_RESOURCES: ResourceSpec = { cpu: 2, memoryGb: 4 };
