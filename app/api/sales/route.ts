import type { NextRequest } from "next/server";

import { BillValidationError, buildSaleLines, createBill } from "@/lib/bills";
import { isPaymentMethod } from "@/lib/payment";
import { clientKey, rateLimit } from "@/lib/rate-limit";

const LIMIT = 60;
const WINDOW_MS = 60_000;

/** Record a completed sale (writes bills.json + sales_report.csv). No stock change. */
export async function POST(request: NextRequest) {
  const gate = rateLimit(`sales:${clientKey(request)}`, LIMIT, WINDOW_MS);
  if (!gate.allowed) {
    return Response.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(gate.retryAfter) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const payload = body as { paymentMethod?: unknown; lines?: unknown };

  if (!isPaymentMethod(payload.paymentMethod)) {
    return Response.json({ error: "Invalid payment method" }, { status: 400 });
  }

  try {
    const lines = await buildSaleLines(payload.lines);
    const bill = await createBill({ lines, paymentMethod: payload.paymentMethod });
    return Response.json(bill, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof BillValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: "Could not record the sale" }, { status: 500 });
  }
}
