import { clampDiscountPercent } from "./money";

/**
 * Discount policy for newly scanned titles.
 *
 * The counter staff can always edit any line afterwards — these are only the
 * starting values.
 */

/** Applied to a scanned title unless that title has its own rule below. */
export const DEFAULT_DISCOUNT_PERCENT = 20;

/**
 * Titles that start at their own discount instead of the shop default.
 * Add an entry here to carve out a title; the value is a percentage.
 */
export const ISBN_DISCOUNT_OVERRIDES: Readonly<Record<string, number>> = {
  // How The Chilli Became Hot — sold at full price.
  "9789377307622": 0,
};

/**
 * The title's own starting discount, or `null` when it simply follows whatever
 * the shop default is currently set to.
 */
export function defaultDiscountFor(isbn: string): number | null {
  const override = ISBN_DISCOUNT_OVERRIDES[isbn];
  return override === undefined ? null : clampDiscountPercent(override);
}
