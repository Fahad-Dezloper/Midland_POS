/**
 * ISBN handling shared by the client and the server.
 *
 * The catalog is keyed by the exact digit string that appears in the stock
 * sheet, so normalisation here only strips the separators a barcode scanner or
 * a human might introduce. It never rewrites the digits themselves.
 */

/** Longest input we are willing to look at before rejecting it outright. */
const MAX_RAW_LENGTH = 32;

/**
 * Strips hyphens, spaces and other separators, uppercases a trailing check
 * digit `x`, and returns `null` if what is left is not a plausible ISBN.
 *
 * Accepts 10 to 13 characters because the stock sheet contains a handful of
 * 10 and 12 digit codes alongside the usual EAN-13s.
 */
export function normalizeIsbn(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > MAX_RAW_LENGTH) return null;

  const cleaned = raw.replace(/[\s\-–—_.]/g, "").toUpperCase();
  if (!/^[0-9]{9,12}[0-9X]$/.test(cleaned)) return null;

  return cleaned;
}

/** Free-text search terms are capped and stripped of control characters. */
export const MAX_QUERY_LENGTH = 64;

export function normalizeQuery(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw
    .slice(0, MAX_QUERY_LENGTH)
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
}
