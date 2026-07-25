import type { NextRequest } from "next/server";

import {
  BillNotFoundError,
  BillValidationError,
  buildSaleLines,
  deleteBill,
  getBill,
  updateBill,
} from "@/lib/bills";
import { isPaymentMethod } from "@/lib/payment";
import { clientKey, rateLimit } from "@/lib/rate-limit";

const LIMIT = 120;
const WINDOW_MS = 60_000;

function limited(request: NextRequest) {
  const gate = rateLimit(`bill:${clientKey(request)}`, LIMIT, WINDOW_MS);
  if (gate.allowed) return null;
  return Response.json(
    { error: "Too many requests" },
    { status: 429, headers: { "Retry-After": String(gate.retryAfter) } },
  );
}

/** Fetch one bill. */
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/bills/[orderId]">,
) {
  const blocked = limited(request);
  if (blocked) return blocked;

  const { orderId } = await ctx.params;
  const bill = await getBill(orderId);
  if (!bill) return Response.json({ error: "Bill not found" }, { status: 404 });

  return Response.json(bill, { headers: { "Cache-Control": "no-store" } });
}

/** Replace a bill's lines and/or payment method, recomputing its totals. */
export async function PUT(
  request: NextRequest,
  ctx: RouteContext<"/api/bills/[orderId]">,
) {
  const blocked = limited(request);
  if (blocked) return blocked;

  const { orderId } = await ctx.params;

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
    const bill = await updateBill(orderId, {
      lines,
      paymentMethod: payload.paymentMethod,
    });
    return Response.json(bill, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof BillNotFoundError) {
      return Response.json({ error: "Bill not found" }, { status: 404 });
    }
    if (error instanceof BillValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error("[/api/bills PUT] failed to update bill:", error);
    return Response.json({ error: "Could not update the bill" }, { status: 500 });
  }
}

/** Delete a bill. */
export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/bills/[orderId]">,
) {
  const blocked = limited(request);
  if (blocked) return blocked;

  const { orderId } = await ctx.params;
  try {
    const removed = await deleteBill(orderId);
    if (!removed) {
      return Response.json({ error: "Bill not found" }, { status: 404 });
    }
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[/api/bills DELETE] failed to delete bill:", error);
    return Response.json({ error: "Could not delete the bill" }, { status: 500 });
  }
}
