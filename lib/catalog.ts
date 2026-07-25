import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseCsv } from "./csv";
import { defaultDiscountFor } from "./discount-rules";
import { normalizeIsbn } from "./isbn";
import { rupeesToPaise } from "./money";

/**
 * Server-only stock catalog.
 *
 * The sheet lives outside `public/` so it is never served as a file; the only
 * way to reach it is through the lookup helpers below, which return one book
 * at a time and never expose the raw rows or any filesystem detail.
 */

if (typeof window !== "undefined") {
  throw new Error("lib/catalog.ts must never be imported into client code");
}

export type Book = {
  isbn: string;
  name: string;
  /** MRP in paise. */
  pricePaise: number;
  /** Total units on hand across every row for this ISBN. */
  stockQty: number;
  /**
   * This title's own starting discount, or `null` to follow the shop default.
   * Only a starting value — the line stays editable either way.
   */
  defaultDiscountPercent: number | null;
};

const CSV_PATH = path.join(process.cwd(), "data", "stock-list.csv");

const COLUMNS = {
  isbn: "ISBN",
  qty: "QTY",
  price: "MRP Final",
  name: "Name",
} as const;

type Catalog = {
  byIsbn: Map<string, Book>;
  /** Stable, name-sorted list backing free-text search. */
  all: Book[];
};

let catalogPromise: Promise<Catalog> | null = null;

async function buildCatalog(): Promise<Catalog> {
  const rows = parseCsv(await readFile(CSV_PATH, "utf8"));
  if (rows.length === 0) throw new Error("Stock list is empty");

  const header = rows[0].map((cell) => cell.trim());
  const index = {
    isbn: header.indexOf(COLUMNS.isbn),
    qty: header.indexOf(COLUMNS.qty),
    price: header.indexOf(COLUMNS.price),
    name: header.indexOf(COLUMNS.name),
  };

  for (const [key, position] of Object.entries(index)) {
    if (position === -1) {
      throw new Error(`Stock list is missing the "${key}" column`);
    }
  }

  const byIsbn = new Map<string, Book>();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    const isbn = normalizeIsbn(row[index.isbn] ?? "");
    const name = (row[index.name] ?? "").trim();
    const price = Number((row[index.price] ?? "").trim());
    const qty = Number((row[index.qty] ?? "").trim());

    // Skip anything malformed rather than surfacing a half-parsed book.
    if (!isbn || !name) continue;
    if (!Number.isFinite(price) || price < 0) continue;

    const existing = byIsbn.get(isbn);
    const stockQty = Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 0;

    if (existing) {
      // The sheet lists the same title on several rows; sum the stock.
      existing.stockQty += stockQty;
      continue;
    }

    byIsbn.set(isbn, {
      isbn,
      name,
      pricePaise: rupeesToPaise(price),
      stockQty,
      defaultDiscountPercent: defaultDiscountFor(isbn),
    });
  }

  const all = [...byIsbn.values()].sort((a, b) => a.name.localeCompare(b.name));

  return { byIsbn, all };
}

/** Loads and indexes the sheet once per server process. */
function getCatalog(): Promise<Catalog> {
  if (!catalogPromise) {
    catalogPromise = buildCatalog().catch((error) => {
      // Let the next request retry instead of caching a transient failure.
      catalogPromise = null;
      throw error;
    });
  }
  return catalogPromise;
}

export async function findByIsbn(isbn: string): Promise<Book | null> {
  const normalized = normalizeIsbn(isbn);
  if (!normalized) return null;

  const { byIsbn } = await getCatalog();
  return byIsbn.get(normalized) ?? null;
}

export const SEARCH_LIMIT = 8;

/**
 * Matches a query against the ISBN prefix and against the title.
 * Titles that start with the query rank above ones that merely contain it.
 */
export async function searchBooks(query: string, limit = SEARCH_LIMIT) {
  const term = query.trim().toLowerCase();
  if (term.length < 2) return [];

  const { all } = await getCatalog();
  const starts: Book[] = [];
  const contains: Book[] = [];

  for (const book of all) {
    if (book.isbn.startsWith(term)) {
      starts.push(book);
    } else {
      const position = book.name.toLowerCase().indexOf(term);
      if (position === 0) starts.push(book);
      else if (position > 0) contains.push(book);
    }

    if (starts.length >= limit) break;
  }

  return [...starts, ...contains].slice(0, limit);
}

export async function catalogSize(): Promise<number> {
  const { all } = await getCatalog();
  return all.length;
}
