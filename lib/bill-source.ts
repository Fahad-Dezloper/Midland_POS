/**
 * Where a bill came from: a normal shop sale (`store`, the default) or an
 * event/stall sale (`event`). Shared by the client and the server.
 *
 * The cashier flips the till into "Event" mode; every bill created while it is
 * on is tagged `event` so it can be badged and filtered on the bills page. It is
 * purely a label — it never changes prices, totals, or any existing bill.
 *
 * No Node-only imports, so this is safe to bundle into client code.
 */

export const BILL_SOURCES = ["store", "event"] as const;

export type BillSource = (typeof BILL_SOURCES)[number];

/** New bills default to a normal store sale unless the till is in Event mode. */
export const DEFAULT_BILL_SOURCE: BillSource = "store";

export function isBillSource(value: unknown): value is BillSource {
  return (
    typeof value === "string" &&
    (BILL_SOURCES as readonly string[]).includes(value)
  );
}

/** Coerces any input (including a legacy bill with no source) to a valid value. */
export function normalizeBillSource(value: unknown): BillSource {
  return isBillSource(value) ? value : DEFAULT_BILL_SOURCE;
}

export function billSourceLabel(source: BillSource): string {
  return source === "event" ? "Event" : "Store";
}
