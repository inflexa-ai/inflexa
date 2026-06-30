/** Shared constants for the EMA (European Medicines Agency) data downloads. */

/**
 * Full referrals catalogue (~600 rows, ~700KB). Updated twice daily at
 * 06:00 and 18:00 Amsterdam time. There is no per-drug query endpoint;
 * we download the bulk file and filter in-process.
 */
export const EMA_REFERRALS_URL = "https://www.ema.europa.eu/en/documents/report/referrals-output-json-report_en.json";
