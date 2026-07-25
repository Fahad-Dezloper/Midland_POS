/**
 * All money in this app is carried as an integer number of paise so that
 * repeated discount arithmetic never accumulates floating point error.
 */

export const MAX_DISCOUNT_PERCENT = 100;

/** Rupees (as they appear in the stock sheet) to paise. */
export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/** Upper bound on a single line price — a guard against a typo like ₹99,99,999. */
export const MAX_PRICE_PAISE = 100_000_000; // ₹10,00,000.00

/** Parses a rupees field into clamped integer paise; junk becomes 0. */
export function parseRupeesToPaise(draft: string): number {
  const rupees = Number(draft);
  if (!Number.isFinite(rupees) || rupees < 0) return 0;
  return Math.min(rupeesToPaise(rupees), MAX_PRICE_PAISE);
}

/** Paise back to a plain rupees string for an editable field (no ₹, no commas). */
export function paiseToRupeesInput(paise: number): string {
  return String(paise / 100);
}

/** Clamps a user supplied discount to 0–100 with two decimal places. */
export function clampDiscountPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.min(Math.max(value, 0), MAX_DISCOUNT_PERCENT);
  return Math.round(clamped * 100) / 100;
}

/** Discount on a line, rounded to the nearest paisa. */
export function discountPaise(pricePaise: number, percent: number): number {
  const pct = clampDiscountPercent(percent);
  return Math.round((pricePaise * pct) / 100);
}

/** Upper bound on units per line — a guard against a stuck scanner or a typo. */
export const MAX_QTY = 999;

/** Quantities are whole units, at least 1. */
export function clampQty(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(Math.floor(value), 1), MAX_QTY);
}

/**
 * Money for one bill line. The discount applies to the whole line (unit price
 * times quantity) and is rounded once, so the totals always add up exactly.
 */
export function lineAmounts(
  pricePaise: number,
  qty: number,
  discountPercent: number,
) {
  const gross = pricePaise * clampQty(qty);
  const off = discountPaise(gross, discountPercent);
  return { gross, off, net: gross - off };
}

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPaise(paise: number): string {
  return inr.format(paise / 100);
}
