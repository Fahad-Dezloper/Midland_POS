import type { ItemCategory } from "./categories";
import {
  MAX_PRICE_PAISE,
  clampDiscountPercent,
  clampQty,
  lineAmounts,
} from "./money";
import type { PaymentMethod } from "./payment";

/**
 * Pure sale computation and shared types.
 *
 * This module never touches the filesystem — persistence lives in `lib/bills.ts`.
 * Keeping the maths here means both "create" and "edit" paths compute totals the
 * exact same way, in integer paise, so a stored bill can never disagree with its
 * lines.
 */

/** Sanity cap on how many distinct lines one bill may contain. */
export const MAX_SALE_LINES = 500;

export type SaleLineInput = {
  /**
   * For catalog items this is confirmed against the sheet by the caller. For
   * assorted items it may be a scanned code, or empty.
   */
  isbn: string;
  name: string;
  category: ItemCategory;
  qty: number;
  unitPricePaise: number;
  discountPercent: number;
};

export type SaleLine = SaleLineInput & {
  grossPaise: number;
  discountPaise: number;
  netPaise: number;
};

export type BillTotals = {
  beforePaise: number;
  discountPaise: number;
  afterPaise: number;
  units: number;
};

/** Re-clamps every number and computes per-line money. Never trusts the caller. */
export function computeLines(inputs: SaleLineInput[]): SaleLine[] {
  return inputs.slice(0, MAX_SALE_LINES).map((l) => {
    const qty = clampQty(l.qty);
    const unitPricePaise = Math.min(
      Math.max(Math.round(l.unitPricePaise) || 0, 0),
      MAX_PRICE_PAISE,
    );
    const discountPercent = clampDiscountPercent(l.discountPercent);
    const { gross, off, net } = lineAmounts(unitPricePaise, qty, discountPercent);
    return {
      isbn: l.isbn,
      name: l.name,
      category: l.category,
      qty,
      unitPricePaise,
      discountPercent,
      grossPaise: gross,
      discountPaise: off,
      netPaise: net,
    };
  });
}

export function computeTotals(lines: SaleLine[]): BillTotals {
  let beforePaise = 0;
  let discountPaise = 0;
  let units = 0;
  for (const l of lines) {
    beforePaise += l.grossPaise;
    discountPaise += l.discountPaise;
    units += l.qty;
  }
  return {
    beforePaise,
    discountPaise,
    afterPaise: beforePaise - discountPaise,
    units,
  };
}

export type Bill = {
  orderId: string;
  /** ISO timestamp of the original sale. */
  soldAt: string;
  /** ISO timestamp of the last edit, if any. */
  updatedAt?: string;
  paymentMethod: PaymentMethod;
  lines: SaleLine[];
  totals: BillTotals;
};
