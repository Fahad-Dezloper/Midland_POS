import type { NextRequest } from "next/server";

import { findByIsbn } from "@/lib/catalog";
import { normalizeIsbn } from "@/lib/isbn";
import { clientKey, rateLimit } from "@/lib/rate-limit";

const LIMIT = 120;
const WINDOW_MS = 60_000;

/** Look up a single title by ISBN. Read-only; never mutates the sheet. */
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/lookup/[isbn]">,
) {
  const gate = rateLimit(`lookup:${clientKey(request)}`, LIMIT, WINDOW_MS);
  if (!gate.allowed) {
    return Response.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(gate.retryAfter) } },
    );
  }

  const { isbn } = await ctx.params;
  const normalized = normalizeIsbn(isbn);

  if (!normalized) {
    return Response.json({ error: "Invalid ISBN" }, { status: 400 });
  }

  const book = await findByIsbn(normalized);

  if (!book) {
    return Response.json(
      { error: "Not in stock list", isbn: normalized },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json(
    { book },
    { headers: { "Cache-Control": "no-store" } },
  );
}
