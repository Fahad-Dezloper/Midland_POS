import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { findByIsbn } from "./catalog";
import {
  MAX_ASSORTED_NAME,
  categoryLabel,
  defaultAssortedName,
  isItemCategory,
  sanitizeItemCode,
} from "./categories";
import { normalizeIsbn } from "./isbn";
import { isPaymentMethod, type PaymentMethod } from "./payment";
import {
  MAX_SALE_LINES,
  type Bill,
  type SaleLine,
  type SaleLineInput,
  computeLines,
  computeTotals,
} from "./sales";

/**
 * JSON-backed bills store — the single source of truth for completed sales.
 *
 * Design notes for durability and speed:
 *  - The whole store is held in memory after the first read, so list/get are
 *    instant and every mutation works on the in-memory array.
 *  - Every write goes through one promise chain (`withLock`) so concurrent
 *    requests can never interleave and clobber each other.
 *  - Writes are atomic: content is written to a temp file and `rename`d over the
 *    target, which is atomic on the same filesystem. A crash mid-write leaves
 *    the previous good file intact — the JSON can never be left half-written.
 *  - A corrupt/unreadable file is moved aside (never deleted) and the store
 *    starts empty rather than crashing the app.
 *  - `sales_report.csv` is regenerated from the store on every change, so the
 *    flat report always matches the bills after edits and deletes.
 */

if (typeof window !== "undefined") {
  throw new Error("lib/bills.ts must never be imported into client code");
}

const DATA_DIR = path.join(process.cwd(), "data");
const BILLS_JSON = path.join(DATA_DIR, "bills.json");
const SALES_CSV = path.join(DATA_DIR, "sales_report.csv");
const STORE_VERSION = 2;

/**
 * Money is computed in integer paise internally (so discounts never drift), but
 * written to the JSON file in rupees so the file is human-readable. On load the
 * rupee amounts are converted back to paise and every line is recomputed, so a
 * hand-edited file can never hold totals that disagree with its own lines.
 */
const toRupees = (paise: number) => Number((paise / 100).toFixed(2));
const rupeesToPaiseSafe = (rupees: unknown) =>
  Math.round((Number(rupees) || 0) * 100);

type StoredLine = {
  isbn: string;
  name: string;
  category: string;
  qty: number;
  unitPrice: number;
  discountPercent: number;
  discountAmount: number;
  lineTotal: number;
};

type StoredBill = {
  orderId: string;
  soldAt: string;
  updatedAt?: string;
  paymentMethod: string;
  lines: StoredLine[];
  totals: { subtotal: number; discount: number; total: number; units: number };
};

/** In-memory bill (paise) → on-disk bill (rupees). */
function toStored(bill: Bill): StoredBill {
  return {
    orderId: bill.orderId,
    soldAt: bill.soldAt,
    ...(bill.updatedAt ? { updatedAt: bill.updatedAt } : {}),
    paymentMethod: bill.paymentMethod,
    lines: bill.lines.map((l) => ({
      isbn: l.isbn,
      name: l.name,
      category: l.category,
      qty: l.qty,
      unitPrice: toRupees(l.unitPricePaise),
      discountPercent: l.discountPercent,
      discountAmount: toRupees(l.discountPaise),
      lineTotal: toRupees(l.netPaise),
    })),
    totals: {
      subtotal: toRupees(bill.totals.beforePaise),
      discount: toRupees(bill.totals.discountPaise),
      total: toRupees(bill.totals.afterPaise),
      units: bill.totals.units,
    },
  };
}

/** Typed errors so the API layer can map them to the right status code. */
export class BillValidationError extends Error {}
export class BillNotFoundError extends Error {}

// ---- In-memory cache ----

let cache: Bill[] | null = null;
let loadPromise: Promise<Bill[]> | null = null;

async function load(): Promise<Bill[]> {
  if (cache) return cache;
  if (!loadPromise) {
    loadPromise = readFromDisk()
      .then((bills) => {
        cache = bills;
        loadPromise = null;
        return bills;
      })
      .catch((err) => {
        loadPromise = null;
        throw err;
      });
  }
  return loadPromise;
}

async function readFromDisk(): Promise<Bill[]> {
  try {
    if (!existsSync(BILLS_JSON)) return [];
    const raw = await readFile(BILLS_JSON, "utf8");
    if (!raw.trim()) return [];
    return normalizeStore(JSON.parse(raw));
  } catch {
    // Corrupt or unreadable: preserve it for forensics, then start clean.
    try {
      await ensureDir();
      await rename(BILLS_JSON, `${BILLS_JSON}.corrupt-${Date.now()}`);
    } catch {
      // If even the backup fails there is nothing safe left to do but continue.
    }
    return [];
  }
}

/** Accepts a stored `{version, bills}` object (or a bare array) and keeps only
 *  structurally valid bills, so one bad record can't poison the whole store. */
function normalizeStore(parsed: unknown): Bill[] {
  const rawBills = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { bills?: unknown })?.bills)
      ? ((parsed as { bills: unknown[] }).bills)
      : [];

  const bills: Bill[] = [];
  for (const raw of rawBills) {
    const bill = coerceBill(raw);
    if (bill) bills.push(bill);
  }
  return bills;
}

function coerceBill(raw: unknown): Bill | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;

  if (typeof b.orderId !== "string" || !b.orderId) return null;
  if (typeof b.soldAt !== "string") return null;
  if (!isPaymentMethod(b.paymentMethod)) return null;
  if (!Array.isArray(b.lines)) return null;

  const inputs: SaleLineInput[] = [];
  for (const rawLine of b.lines) {
    if (!rawLine || typeof rawLine !== "object") continue;
    const l = rawLine as Record<string, unknown>;
    // Prefer the rupee field (`unitPrice`); fall back to a legacy paise field.
    const unitPricePaise =
      typeof l.unitPrice !== "undefined"
        ? rupeesToPaiseSafe(l.unitPrice)
        : Number(l.unitPricePaise) || 0;
    inputs.push({
      isbn: typeof l.isbn === "string" ? l.isbn : "",
      name: typeof l.name === "string" ? l.name : "",
      category: isItemCategory(l.category) ? l.category : "catalog",
      qty: Number(l.qty),
      unitPricePaise,
      discountPercent: Number(l.discountPercent),
    });
  }
  if (inputs.length === 0) return null;

  // Recompute money from the raw lines so a hand-edited file can't produce
  // totals that disagree with its own lines.
  const lines = computeLines(inputs);
  return {
    orderId: b.orderId,
    soldAt: b.soldAt,
    updatedAt: typeof b.updatedAt === "string" ? b.updatedAt : undefined,
    paymentMethod: b.paymentMethod,
    lines,
    totals: computeTotals(lines),
  };
}

// ---- Serialized, atomic persistence ----

let writeQueue: Promise<unknown> = Promise.resolve();
let tmpCounter = 0;

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run as Promise<T>;
}

async function ensureDir() {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
}

async function atomicWrite(target: string, contents: string) {
  const tmp = `${target}.tmp-${process.pid}-${tmpCounter++}`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, target);
}

async function persist(bills: Bill[]) {
  await ensureDir();
  // JSON is canonical — write it first and fail loudly if it can't be saved.
  await atomicWrite(
    BILLS_JSON,
    JSON.stringify({ version: STORE_VERSION, bills: bills.map(toStored) }, null, 2),
  );
  // CSV is a derived export — best effort, never fail the sale over it.
  try {
    await atomicWrite(SALES_CSV, buildCsv(bills));
  } catch {
    // Ignore: the canonical store is safe and the CSV will regenerate next time.
  }
}

// ---- CSV export ----

const CSV_HEADER = [
  "Order ID",
  "Date",
  "Time",
  "ISBN",
  "Name",
  "Category",
  "Qty",
  "Unit Price (INR)",
  "Discount %",
  "Discount (INR)",
  "Line Total (INR)",
  "Payment Method",
];

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const rupees = (paise: number) => (paise / 100).toFixed(2);

function csvField(value: string): string {
  let s = value;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildCsv(bills: Bill[]): string {
  const rows = [CSV_HEADER.map(csvField).join(",")];
  for (const bill of bills) {
    const when = new Date(bill.soldAt);
    const date = Number.isNaN(when.getTime())
      ? ""
      : `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
    const time = Number.isNaN(when.getTime())
      ? ""
      : `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
    for (const c of bill.lines) {
      rows.push(
        [
          bill.orderId,
          date,
          time,
          c.isbn,
          c.name,
          categoryLabel(c.category),
          String(c.qty),
          rupees(c.unitPricePaise),
          String(c.discountPercent),
          rupees(c.discountPaise),
          rupees(c.netPaise),
          bill.paymentMethod,
        ]
          .map(csvField)
          .join(","),
      );
    }
  }
  return rows.join("\n") + "\n";
}

// ---- Order id ----

function genOrderId(now: Date, bills: Bill[]): string {
  const base =
    `MID-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`;

  const taken = new Set(bills.map((b) => b.orderId));
  if (!taken.has(base)) return base;
  let i = 1;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// ---- Line validation (shared by create + update) ----

/**
 * Turns raw client line objects into validated `SaleLineInput`s. Catalog items
 * must exist in the sheet and take their name from it; assorted items keep an
 * optional sanitised code and the cashier's name. Throws `BillValidationError`.
 */
export async function buildSaleLines(rawLines: unknown): Promise<SaleLineInput[]> {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new BillValidationError("The bill is empty");
  }
  if (rawLines.length > MAX_SALE_LINES) {
    throw new BillValidationError("Too many items");
  }

  const lines: SaleLineInput[] = [];
  for (const raw of rawLines) {
    const item = (raw ?? {}) as {
      isbn?: unknown;
      name?: unknown;
      category?: unknown;
      qty?: unknown;
      unitPricePaise?: unknown;
      discountPercent?: unknown;
    };

    const category = isItemCategory(item.category) ? item.category : "catalog";

    let isbn: string;
    let name: string;

    if (category === "catalog") {
      const normalized = normalizeIsbn(String(item.isbn ?? ""));
      if (!normalized) throw new BillValidationError("Invalid ISBN in bill");
      const book = await findByIsbn(normalized);
      if (!book) {
        throw new BillValidationError(`${normalized} is not in the stock list`);
      }
      isbn = normalized;
      name = book.name;
    } else {
      isbn = sanitizeItemCode(String(item.isbn ?? ""));
      name =
        String(item.name ?? "")
          .trim()
          .slice(0, MAX_ASSORTED_NAME) || defaultAssortedName(category);
    }

    const qty = Number(item.qty);
    const unitPricePaise = Number(item.unitPricePaise);
    const discountPercent = Number(item.discountPercent);
    if (
      !Number.isFinite(qty) ||
      !Number.isFinite(unitPricePaise) ||
      !Number.isFinite(discountPercent)
    ) {
      throw new BillValidationError("Invalid line values");
    }

    lines.push({ isbn, name, category, qty, unitPricePaise, discountPercent });
  }

  return lines;
}

// ---- Public CRUD ----

export async function listBills(): Promise<Bill[]> {
  const bills = await load();
  // Newest first for the management view.
  return [...bills].sort((a, b) => (a.soldAt < b.soldAt ? 1 : -1));
}

export async function getBill(orderId: string): Promise<Bill | null> {
  const bills = await load();
  return bills.find((b) => b.orderId === orderId) ?? null;
}

export async function createBill(input: {
  lines: SaleLineInput[];
  paymentMethod: PaymentMethod;
}): Promise<Bill> {
  const lines = computeLines(input.lines);
  if (lines.length === 0) {
    throw new BillValidationError("A sale needs at least one line");
  }

  return withLock(async () => {
    const bills = await load();
    const now = new Date();
    const bill: Bill = {
      orderId: genOrderId(now, bills),
      soldAt: now.toISOString(),
      paymentMethod: input.paymentMethod,
      lines,
      totals: computeTotals(lines),
    };
    const next = [...bills, bill];
    await persist(next);
    cache = next;
    return bill;
  });
}

export async function updateBill(
  orderId: string,
  input: { lines: SaleLineInput[]; paymentMethod: PaymentMethod },
): Promise<Bill> {
  const lines = computeLines(input.lines);
  if (lines.length === 0) {
    throw new BillValidationError("A bill needs at least one line");
  }

  return withLock(async () => {
    const bills = await load();
    const index = bills.findIndex((b) => b.orderId === orderId);
    if (index === -1) throw new BillNotFoundError(orderId);

    const updated: Bill = {
      ...bills[index],
      paymentMethod: input.paymentMethod,
      lines,
      totals: computeTotals(lines),
      updatedAt: new Date().toISOString(),
    };
    const next = bills.slice();
    next[index] = updated;
    await persist(next);
    cache = next;
    return updated;
  });
}

export async function deleteBill(orderId: string): Promise<boolean> {
  return withLock(async () => {
    const bills = await load();
    const next = bills.filter((b) => b.orderId !== orderId);
    if (next.length === bills.length) return false;
    await persist(next);
    cache = next;
    return true;
  });
}

export type { Bill, SaleLine };
