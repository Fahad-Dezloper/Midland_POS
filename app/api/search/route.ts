import type { NextRequest } from "next/server";

import { searchBooks } from "@/lib/catalog";
import { normalizeQuery } from "@/lib/isbn";
import { clientKey, rateLimit } from "@/lib/rate-limit";

const LIMIT = 180;
const WINDOW_MS = 60_000;

/** Type-ahead over ISBN prefixes and titles. Read-only. */
export async function GET(request: NextRequest) {
  const gate = rateLimit(`search:${clientKey(request)}`, LIMIT, WINDOW_MS);
  if (!gate.allowed) {
    return Response.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(gate.retryAfter) } },
    );
  }

  const query = normalizeQuery(request.nextUrl.searchParams.get("q") ?? "");
  if (query.length < 2) {
    return Response.json({ books: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  const books = await searchBooks(query);

  return Response.json({ books }, { headers: { "Cache-Control": "no-store" } });
}
