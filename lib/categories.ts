/**
 * Item categories, shared by the client and the server.
 *
 * `catalog`  — a real title from the stock sheet.
 * `assorted-books` / `assorted-stationery` — walk-in items that are not in the
 * sheet; the cashier types a price (and optionally a name) at the till.
 *
 * No Node-only imports, so this is safe to bundle into client code.
 */

export const ITEM_CATEGORIES = [
  "catalog",
  "assorted-books",
  "assorted-stationery",
] as const;

export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export function isItemCategory(value: unknown): value is ItemCategory {
  return (
    typeof value === "string" &&
    (ITEM_CATEGORIES as readonly string[]).includes(value)
  );
}

/** Human-friendly label used in the sales report and receipt. */
export function categoryLabel(category: ItemCategory): string {
  switch (category) {
    case "assorted-books":
      return "Assorted Books";
    case "assorted-stationery":
      return "Assorted Stationery";
    default:
      return "Catalog";
  }
}

/** Default name for an assorted line when the cashier leaves the name blank. */
export function defaultAssortedName(category: ItemCategory): string {
  return category === "assorted-stationery"
    ? "Assorted Stationery"
    : "Assorted Book";
}

/** Longest assorted name we will store. */
export const MAX_ASSORTED_NAME = 120;

/** Longest item code (ISBN/barcode) we will store for an assorted line. */
export const MAX_ITEM_CODE = 20;

/**
 * Cleans an optional item code for an assorted line. Unlike a catalog ISBN it
 * is not validated against the sheet, so we only strip it to a safe character
 * set (digits, letters, hyphens) and cap its length.
 */
export function sanitizeItemCode(raw: string): string {
  return raw
    .replace(/[^0-9A-Za-z-]/g, "")
    .slice(0, MAX_ITEM_CODE)
    .toUpperCase();
}
