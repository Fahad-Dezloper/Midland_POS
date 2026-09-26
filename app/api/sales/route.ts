import type { NextRequest } from "next/server";

import { normalizeBillSource } from "@/lib/bill-source";
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

  const payload = body as {
    paymentMethod?: unknown;
    lines?: unknown;
    source?: unknown;
  };

  if (!isPaymentMethod(payload.paymentMethod)) {
    return Response.json({ error: "Invalid payment method" }, { status: 400 });
  }

  // On Vercel the filesystem is read-only, so a Blob store must be configured.
  if (process.env.VERCEL && !process.env.BLOB_READ_WRITE_TOKEN) {
    return Response.json(
      {
        error: "Could not record the sale",
        detail:
          "Storage is not configured: BLOB_READ_WRITE_TOKEN is missing in this deployment. Add it in Vercel → Settings → Environment Variables (Production), then redeploy.",
      },
      { status: 500 },
    );
  }

  try {
    const lines = await buildSaleLines(payload.lines);
    const bill = await createBill({
      lines,
      paymentMethod: payload.paymentMethod,
      source: normalizeBillSource(payload.source),
    });
    return Response.json(bill, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof BillValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    // Surface the real cause (e.g. EROFS on read-only FS, or a Blob error).
    console.error("[/api/sales] failed to record sale:", error);
    const detail = error instanceof Error ? error.message : "Unknown error";
    return Response.json(
      { error: "Could not record the sale", detail },
      { status: 500 },
    );
  }
}
