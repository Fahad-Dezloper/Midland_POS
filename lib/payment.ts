/**
 * Payment methods, shared by the client checkout and the server recorder.
 *
 * This module is intentionally free of any Node-only imports so it can be
 * bundled into client code (unlike `lib/sales.ts`, which touches the filesystem).
 */

export const PAYMENT_METHODS = ["Cash", "Card", "UPI"] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return (
    typeof value === "string" &&
    (PAYMENT_METHODS as readonly string[]).includes(value)
  );
}
