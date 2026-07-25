import type { NextRequest } from "next/server";

import { listBills } from "@/lib/bills";
import { clientKey, rateLimit } from "@/lib/rate-limit";

const LIMIT = 120;
const WINDOW_MS = 60_000;

/** List every recorded bill, newest first. */
export async function GET(request: NextRequest) {
  const gate = rateLimit(`bills:${clientKey(request)}`, LIMIT, WINDOW_MS);
  if (!gate.allowed) {
    return Response.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(gate.retryAfter) } },
    );
  }

  const bills = await listBills();
  return Response.json({ bills }, { headers: { "Cache-Control": "no-store" } });
}
