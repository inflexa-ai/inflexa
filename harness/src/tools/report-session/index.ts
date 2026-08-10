/**
 * The report-session tool barrel.
 *
 * These tools serve a `report` thread. The runtime constructs them over the session-state gateway and the
 * render seams, thus each tool binds the per-session state to the thread of the call. The barrel exports
 * the factories and their public types for the composition root.
 */

export { createPreviewReportTool, type PreviewReportInput, type PreviewReportResult, type PreviewReportToolDeps } from "./preview-report.js";
