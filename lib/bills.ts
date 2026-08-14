import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { findByIsbn } from "./catalog";
import {
  MAX_ASSORTED_NAME,
  categoryLabel,
  defaultAssortedName,
  isItemCategory,
  normalizeGstRate,
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
 * The storage backend is pluggable (see `getDriver`):
 *  - Local / any host with a writable disk → an atomic JSON file under `data/`.
 *  - Vercel (read-only filesystem) → Vercel Blob, selected automatically when
 *    `BLOB_READ_WRITE_TOKEN` is set. Same single JSON document, different sink.
 *
 * Durability notes:
 *  - Every write goes through one promise chain (`withLock`) so concurrent
 *    requests on the same instance can never interleave and clobber each other.
 *  - Each mutation reads the latest store, applies its change, then writes —
 *    so it always builds on current data, even across serverless instances.
 *  - The filesystem backend writes atomically (temp file + rename) so a crash
 *    mid-write can never leave a half-written file. The Blob backend reads with
 *    caching disabled and treats "not found" (never "error") as an empty store,
 *    so a transient failure can never overwrite good data with nothing.
 *  - A corrupt/unparseable document is backed up (never destroyed) and the
 *    store starts empty rather than crashing the app.
 *  - `sales_report.csv` is regenerated from the store on every change (on the
 *    filesystem backend), so the flat report always matches the bills.
 */

if (typeof window !== "undefined") {
  throw new Error("lib/bills.ts must never be imported into client code");
}

/**
 * Where the writable bills store lives. Defaults to `./data` next to the app.
 *
 * On hosts with a read-only filesystem (Vercel, Netlify, most serverless), that
 * default cannot be written and every sale would fail. Set `MIDLAND_DATA_DIR`
 * to a writable, persistent path (a mounted volume on a VPS / Railway / Render /
 * Docker) to fix it. `/tmp` is writable on serverless but ephemeral — data there
 * is wiped between invocations and deploys, so it is only useful for testing.
 */
const DATA_DIR = process.env.MIDLAND_DATA_DIR
  ? path.resolve(process.env.MIDLAND_DATA_DIR)
  : path.join(process.cwd(), "data");
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
  /** GST rate for assorted stationery; omitted for other lines. */
  gstPercent?: number;
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
      ...(l.gstPercent != null ? { gstPercent: l.gstPercent } : {}),
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

// ---- Storage driver (filesystem locally, Vercel Blob when deployed) ----

type StoreDriver = {
  /** Returns the stored JSON string, or null if the store is empty/absent. */
  readJson(): Promise<string | null>;
  writeJson(content: string): Promise<void>;
  writeCsv(content: string): Promise<void>;
  backupCorrupt(content: string): Promise<void>;
};

let driverPromise: Promise<StoreDriver> | null = null;

function getDriver(): Promise<StoreDriver> {
  if (!driverPromise) {
    driverPromise = process.env.BLOB_READ_WRITE_TOKEN
      ? import("./bills-blob").then((m) => m.createBlobDriver())
      : Promise.resolve(createFsDriver());
  }
  return driverPromise;
}

// --- Filesystem backend ---

let tmpCounter = 0;

async function ensureDir() {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
}

async function atomicWrite(target: string, contents: string) {
  await ensureDir();
  const tmp = `${target}.tmp-${process.pid}-${tmpCounter++}`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, target);
}

function createFsDriver(): StoreDriver {
  return {
    async readJson() {
      if (!existsSync(BILLS_JSON)) return null;
      return readFile(BILLS_JSON, "utf8");
    },
    async writeJson(content) {
      await atomicWrite(BILLS_JSON, content);
    },
    async writeCsv(content) {
      await atomicWrite(SALES_CSV, content);
    },
    async backupCorrupt(content) {
      try {
        await atomicWrite(`${BILLS_JSON}.corrupt-${Date.now()}`, content);
      } catch {
        // Best effort.
      }
    },
  };
}

/** Reads and normalises the whole store. Throws only on real read errors (so a
 *  transient failure can never be mistaken for an empty store). */
async function readAll(): Promise<Bill[]> {
  const driver = await getDriver();
  const raw = await driver.readJson();
  if (!raw || !raw.trim()) return [];
  try {
    return normalizeStore(JSON.parse(raw));
  } catch {
    // Unparseable: preserve the bad content for forensics, then start clean.
    await driver.backupCorrupt(raw);
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
    const category = isItemCategory(l.category) ? l.category : "catalog";
    inputs.push({
      isbn: typeof l.isbn === "string" ? l.isbn : "",
      name: typeof l.name === "string" ? l.name : "",
      category,
      qty: Number(l.qty),
      unitPricePaise,
      discountPercent: Number(l.discountPercent),
      gstPercent:
        category === "assorted-stationery" && l.gstPercent != null
          ? normalizeGstRate(l.gstPercent)
          : null,
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

// ---- Serialized persistence ----

let writeQueue: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run as Promise<T>;
}

async function persist(bills: Bill[]) {
  const driver = await getDriver();
  // JSON is canonical — write it first and fail loudly if it can't be saved.
  await driver.writeJson(
    JSON.stringify({ version: STORE_VERSION, bills: bills.map(toStored) }, null, 2),
  );
  // CSV is a derived export — best effort, never fail the sale over it.
  try {
    await driver.writeCsv(buildCsv(bills));
  } catch {
    // Ignore: the canonical store is safe and the CSV regenerates next time.
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
  "GST %",
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

export function buildCsv(bills: Bill[]): string {
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
          c.gstPercent != null ? String(c.gstPercent) : "",
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
      gstPercent?: unknown;
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

    const gstPercent =
      category === "assorted-stationery"
        ? normalizeGstRate(item.gstPercent)
        : null;

    lines.push({
      isbn,
      name,
      category,
      qty,
      unitPricePaise,
      discountPercent,
      gstPercent,
    });
  }

  return lines;
}

// ---- Public CRUD ----

export async function listBills(): Promise<Bill[]> {
  const bills = await readAll();
  // Newest first for the management view.
  return [...bills].sort((a, b) => (a.soldAt < b.soldAt ? 1 : -1));
}

export async function getBill(orderId: string): Promise<Bill | null> {
  const bills = await readAll();
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
    const bills = await readAll();
    const now = new Date();
    const bill: Bill = {
      orderId: genOrderId(now, bills),
      soldAt: now.toISOString(),
      paymentMethod: input.paymentMethod,
      lines,
      totals: computeTotals(lines),
    };
    await persist([...bills, bill]);
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
    const bills = await readAll();
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
    return updated;
  });
}

export async function deleteBill(orderId: string): Promise<boolean> {
  return withLock(async () => {
    const bills = await readAll();
    const next = bills.filter((b) => b.orderId !== orderId);
    if (next.length === bills.length) return false;
    await persist(next);
    return true;
  });
}

export type { Bill, SaleLine };
