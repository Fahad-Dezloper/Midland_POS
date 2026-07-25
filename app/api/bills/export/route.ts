import type { NextRequest } from "next/server";

import { buildCsv, listBills } from "@/lib/bills";
import { clientKey, rateLimit } from "@/lib/rate-limit";

const LIMIT = 30;
const WINDOW_MS = 60_000;

const pad = (n: number) => String(n).padStart(2, "0");

/** Download every bill as a single CSV (opens in Excel). */
export async function GET(request: NextRequest) {
  const gate = rateLimit(`export:${clientKey(request)}`, LIMIT, WINDOW_MS);
  if (!gate.allowed) {
    return Response.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(gate.retryAfter) } },
    );
  }

  const bills = await listBills();
  // Report reads best oldest-first (chronological).
  const ordered = [...bills].sort((a, b) => (a.soldAt < b.soldAt ? -1 : 1));

  // A leading BOM makes Excel read the file as UTF-8 (₹ and quoted names intact).
  const csv = "﻿" + buildCsv(ordered);

  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="sales_report-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
