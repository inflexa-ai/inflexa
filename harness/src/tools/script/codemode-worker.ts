/**
 * The entry of the worker thread of `run_script`. An embedder that bundles the harness, for example a Bun single-file
 * binary, adds this module as an entry of its build, and gives its embedded path as `ScriptRuntime.workerUrl`.
 */

import "@earendil-works/pi-codemode/worker";
