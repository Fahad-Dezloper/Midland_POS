"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type ItemCategory,
  defaultAssortedName,
  sanitizeItemCode,
} from "@/lib/categories";
import { DEFAULT_DISCOUNT_PERCENT } from "@/lib/discount-rules";
import { normalizeIsbn } from "@/lib/isbn";
import { PAYMENT_METHODS } from "@/lib/payment";
import { type ReceiptBill, downloadReceipt } from "@/lib/receipt";
import {
  MAX_DISCOUNT_PERCENT,
  MAX_PRICE_PAISE,
  MAX_QTY,
  clampDiscountPercent,
  clampQty,
  formatPaise,
  lineAmounts,
  paiseToRupeesInput,
  parseRupeesToPaise,
} from "@/lib/money";

type Book = {
  isbn: string;
  name: string;
  pricePaise: number;
  stockQty: number;
  /** The title's own starting discount, or null to follow the shop default. */
  defaultDiscountPercent: number | null;
};

type Line = Book & {
  /** Stable key, independent of the ISBN. */
  id: number;
  /** catalog | assorted-books | assorted-stationery. */
  category: ItemCategory;
  qty: number;
  discountPercent: number;
  /**
   * What the user is currently typing in each editable cell. Kept apart from
   * the numeric values so a field can be emptied or hold "12." mid-edit without
   * snapping back.
   */
  qtyDraft: string;
  priceDraft: string;
  discountDraft: string;
};

type Status = { tone: "error" | "warn" | "ok"; message: string } | null;

/** The editable cells, in the order Enter walks through them. */
type Field = "qty" | "price" | "discount";
const cellId = (id: number, field: Field) => `cell-${id}-${field}`;
const SELL_BUTTON_ID = "sell-button";

/** Per-line money, derived rather than stored so it can never drift. */
const lineTotals = (line: Line) =>
  lineAmounts(line.pricePaise, line.qty, line.discountPercent);

export default function SaleTerminal({ catalogSize }: { catalogSize: number }) {
  const [query, setQuery] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [defaultDiscount, setDefaultDiscount] = useState(
    DEFAULT_DISCOUNT_PERCENT,
  );
  const [defaultDraft, setDefaultDraft] = useState(
    String(DEFAULT_DISCOUNT_PERCENT),
  );
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  // Checkout modal
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [paymentIndex, setPaymentIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // Assorted / not-in-list modal
  const [assortedOpen, setAssortedOpen] = useState(false);
  const [assortedCategory, setAssortedCategory] =
    useState<ItemCategory>("assorted-books");
  const [assortedName, setAssortedName] = useState("");
  const [assortedPriceDraft, setAssortedPriceDraft] = useState("");
  const [assortedIsbn, setAssortedIsbn] = useState("");
  const [assortedNotInList, setAssortedNotInList] = useState(false);

  // Duplicate-item confirm modal
  const [duplicate, setDuplicate] = useState<{ id: number; name: string } | null>(
    null,
  );

  const scanRef = useRef<HTMLInputElement>(null);
  const checkoutRef = useRef<HTMLDivElement>(null);
  const assortedRef = useRef<HTMLDivElement>(null);
  const assortedPriceRef = useRef<HTMLInputElement>(null);
  const duplicateBtnRef = useRef<HTMLButtonElement>(null);
  const nextId = useRef(1);
  const lookupAbort = useRef<AbortController | null>(null);
  /** Mirror of `lines` so callbacks can read the current bill without stale closures. */
  const linesRef = useRef<Line[]>([]);

  const focusCell = (id: number, field: Field) => {
    const el = document.getElementById(cellId(id, field));
    if (el instanceof HTMLInputElement) {
      el.focus();
      el.select();
    }
  };

  // Keep the mirror in sync so callbacks (addBook) can read the current bill.
  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  /**
   * Scanning a catalog title already on the bill does not silently bump the
   * quantity — it opens a confirm modal so the cashier can decide. A brand-new
   * title is added straight to the top of the bill.
   */
  /** Replaces the bill, keeping the synchronous mirror in lockstep so the very
   *  next scan sees current data even before React commits the render. */
  const commitLines = (next: Line[]) => {
    linesRef.current = next;
    setLines(next);
  };

  const addBook = useCallback(
    (book: Book) => {
      const existing = linesRef.current.find(
        (line) => line.category === "catalog" && line.isbn === book.isbn,
      );
      if (existing) {
        setQuery("");
        setStatus(null);
        setDuplicate({ id: existing.id, name: existing.name });
        return;
      }

      // A title with its own rule ignores the shop default when it lands on the
      // bill; either way the line stays editable afterwards.
      const percent = book.defaultDiscountPercent ?? defaultDiscount;
      const id = nextId.current++;
      // Newest book goes on top of the bill.
      commitLines([
        {
          ...book,
          id,
          category: "catalog",
          qty: 1,
          qtyDraft: "1",
          priceDraft: paiseToRupeesInput(book.pricePaise),
          discountPercent: percent,
          discountDraft: String(percent),
        },
        ...linesRef.current,
      ]);

      setQuery("");
      setStatus(
        book.stockQty === 0
          ? {
              tone: "warn",
              message: `${book.name} — no quantity left in stock`,
            }
          : { tone: "ok", message: `Added ${book.name}` },
      );
      // Keep focus on the scan box, ready for the next book.
      scanRef.current?.focus();
    },
    [defaultDiscount],
  );

  /** Bumps the duplicated line's quantity and closes the modal. */
  const confirmDuplicate = () => {
    if (!duplicate) return;
    const { id, name } = duplicate;
    commitLines(
      linesRef.current.map((line) => {
        if (line.id !== id) return line;
        const qty = clampQty(line.qty + 1);
        return { ...line, qty, qtyDraft: String(qty) };
      }),
    );
    setDuplicate(null);
    setStatus({ tone: "ok", message: `Updated quantity for ${name}` });
    // Back to the scan box for the next book.
    scanRef.current?.focus();
  };

  const cancelDuplicate = () => {
    setDuplicate(null);
    scanRef.current?.focus();
  };

  const onDuplicateKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmDuplicate();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelDuplicate();
    }
  };

  // Focus the default "Update quantity" button when the duplicate modal opens.
  useEffect(() => {
    if (duplicate) duplicateBtnRef.current?.focus();
  }, [duplicate]);

  /** Adds a walk-in item that is not in the catalog. Never merges into a row. */
  const addAssortedLine = useCallback(
    (opts: {
      category: ItemCategory;
      name: string;
      pricePaise: number;
      isbn: string;
    }) => {
      const name = opts.name.trim() || defaultAssortedName(opts.category);
      const id = nextId.current++;

      commitLines([
        {
          isbn: opts.isbn,
          name,
          pricePaise: opts.pricePaise,
          stockQty: 0,
          defaultDiscountPercent: null,
          id,
          category: opts.category,
          qty: 1,
          qtyDraft: "1",
          priceDraft: paiseToRupeesInput(opts.pricePaise),
          discountPercent: defaultDiscount,
          discountDraft: String(defaultDiscount),
        },
        ...linesRef.current,
      ]);

      setQuery("");
      setStatus({ tone: "ok", message: `Added ${name}` });
      scanRef.current?.focus();
    },
    [defaultDiscount],
  );

  const lookupAndAdd = useCallback(
    async (raw: string) => {
      const isbn = normalizeIsbn(raw);
      if (!isbn) {
        setStatus({
          tone: "error",
          message: "Scan a barcode or type a valid ISBN.",
        });
        return;
      }

      lookupAbort.current?.abort();
      const controller = new AbortController();
      lookupAbort.current = controller;

      setBusy(true);
      try {
        const response = await fetch(
          `/api/lookup/${encodeURIComponent(isbn)}`,
          {
            signal: controller.signal,
          },
        );

        if (response.status === 404) {
          // Not in the sheet — offer to sell it as an assorted book.
          setAssortedCategory("assorted-books");
          setAssortedName("");
          setAssortedPriceDraft("");
          setAssortedIsbn(isbn);
          setAssortedNotInList(true);
          setAssortedOpen(true);
          return;
        }
        if (!response.ok) {
          setStatus({ tone: "error", message: "Lookup failed. Try again." });
          return;
        }

        const data: { book?: Book } = await response.json();
        if (data.book) addBook(data.book);
      } catch (error) {
        if ((error as Error)?.name !== "AbortError") {
          setStatus({ tone: "error", message: "Lookup failed. Try again." });
        }
      } finally {
        if (lookupAbort.current === controller) setBusy(false);
      }
    },
    [addBook],
  );

  const patchLine = (id: number, patch: (line: Line) => Line) => {
    setLines((current) =>
      current.map((line) => (line.id === id ? patch(line) : line)),
    );
  };

  /** Quantity is never capped at stock — overselling is allowed, just flagged. */
  const editQty = (id: number, draft: string) =>
    patchLine(id, (line) => ({
      ...line,
      qtyDraft: draft,
      qty: draft.trim() === "" ? 1 : clampQty(Number(draft)),
    }));

  const editPrice = (id: number, draft: string) =>
    patchLine(id, (line) => ({
      ...line,
      priceDraft: draft,
      pricePaise: parseRupeesToPaise(draft),
    }));

  const editDiscount = (id: number, draft: string) =>
    patchLine(id, (line) => ({
      ...line,
      discountDraft: draft,
      discountPercent: clampDiscountPercent(
        draft.trim() === "" ? 0 : Number(draft),
      ),
    }));

  /** On blur each draft is rewritten as the value that was actually used. */
  const commitDrafts = (id: number) =>
    patchLine(id, (line) => ({
      ...line,
      qtyDraft: String(line.qty),
      priceDraft: paiseToRupeesInput(line.pricePaise),
      discountDraft: String(line.discountPercent),
    }));

  /**
   * Keyboard flow inside a row: Enter walks qty → price → discount → Sell.
   * Escape jumps back to the scan box so the next item can be scanned.
   */
  const onCellKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
    id: number,
    next: Field | "sell",
  ) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitDrafts(id);
      if (next === "sell") {
        document.getElementById(SELL_BUTTON_ID)?.focus();
      } else {
        focusCell(id, next);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      scanRef.current?.focus();
    }
  };

  const removeLine = (id: number) => {
    setLines((current) => current.filter((line) => line.id !== id));
  };

  /**
   * Titles with their own rule keep it — otherwise one click would silently
   * undo the carve-out. Those lines can still be edited individually.
   */
  const applyDiscountToAll = () => {
    setLines((current) =>
      current.map((line) => {
        const percent = line.defaultDiscountPercent ?? defaultDiscount;
        return {
          ...line,
          discountPercent: percent,
          discountDraft: String(percent),
        };
      }),
    );
  };

  const totals = useMemo(() => {
    let before = 0;
    let discount = 0;
    let units = 0;
    let short = 0;
    for (const line of lines) {
      const { gross, off } = lineTotals(line);
      before += gross;
      discount += off;
      units += line.qty;
      if (line.qty > line.stockQty) short++;
    }
    return { before, discount, after: before - discount, units, short };
  }, [lines]);

  /** Sell opens the payment modal rather than finishing immediately. */
  const openCheckout = () => {
    if (lines.length === 0) return;
    setCheckoutError(null);
    setCheckoutOpen(true);
  };

  const closeCheckout = () => {
    if (submitting) return;
    setCheckoutOpen(false);
    document.getElementById(SELL_BUTTON_ID)?.focus();
  };

  // Focus the modal when it opens so its keyboard shortcuts work immediately.
  useEffect(() => {
    if (checkoutOpen) checkoutRef.current?.focus();
  }, [checkoutOpen]);

  /**
   * Records the sale on the server (which writes sales_report.csv), downloads
   * the receipt, and clears the bill for the next customer.
   */
  const confirmSale = async () => {
    if (lines.length === 0 || submitting) return;

    setSubmitting(true);
    setCheckoutError(null);
    try {
      const response = await fetch("/api/sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentMethod: PAYMENT_METHODS[paymentIndex],
          lines: lines.map((l) => ({
            isbn: l.isbn,
            name: l.name,
            category: l.category,
            qty: l.qty,
            unitPricePaise: l.pricePaise,
            discountPercent: l.discountPercent,
          })),
        }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        setCheckoutError(data.error ?? "Could not record the sale.");
        return;
      }

      const sale: ReceiptBill = await response.json();
      downloadReceipt(sale);

      setCheckoutOpen(false);
      setLines([]);
      setQuery("");
      setPaymentIndex(0);
      setStatus({
        tone: "ok",
        message: `Sale ${sale.orderId} recorded — receipt downloaded.`,
      });
      scanRef.current?.focus();
    } catch {
      setCheckoutError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  /** Clear the current bill without recording anything. */
  const newSale = () => {
    setLines([]);
    setStatus(null);
    setQuery("");
    scanRef.current?.focus();
  };

  const onCheckoutKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (submitting) {
      if (event.key === "Escape") event.preventDefault();
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      setPaymentIndex((i) => (i + 1) % PAYMENT_METHODS.length);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      setPaymentIndex(
        (i) => (i - 1 + PAYMENT_METHODS.length) % PAYMENT_METHODS.length,
      );
    } else if (event.key === "Tab") {
      event.preventDefault();
      const step = event.shiftKey ? -1 : 1;
      setPaymentIndex(
        (i) => (i + step + PAYMENT_METHODS.length) % PAYMENT_METHODS.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      void confirmSale();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeCheckout();
    }
  };

  // ---- Assorted / not-in-list item ----

  const openAssorted = (category: ItemCategory) => {
    setAssortedCategory(category);
    setAssortedName("");
    setAssortedPriceDraft("");
    setAssortedIsbn("");
    setAssortedNotInList(false);
    setAssortedOpen(true);
  };

  const closeAssorted = () => {
    setAssortedOpen(false);
    scanRef.current?.focus();
  };

  const assortedPricePaise = parseRupeesToPaise(assortedPriceDraft);
  const assortedPriceValid =
    assortedPriceDraft.trim() !== "" && assortedPricePaise > 0;

  const saveAssorted = () => {
    if (!assortedPriceValid) {
      assortedPriceRef.current?.focus();
      return;
    }
    addAssortedLine({
      category: assortedCategory,
      name: assortedName,
      pricePaise: assortedPricePaise,
      isbn: sanitizeItemCode(assortedIsbn),
    });
    setAssortedOpen(false);
  };

  const onAssortedKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveAssorted();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeAssorted();
    }
  };

  // Focus the price field when the assorted modal opens.
  useEffect(() => {
    if (assortedOpen) assortedPriceRef.current?.focus();
  }, [assortedOpen]);

  // F3 → assorted book, F4 → assorted stationery (browser defaults suppressed).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "F3" && event.key !== "F4") return;
      event.preventDefault();
      if (checkoutOpen || assortedOpen || duplicate) return;
      const category: ItemCategory =
        event.key === "F3" ? "assorted-books" : "assorted-stationery";
      setAssortedCategory(category);
      setAssortedName("");
      setAssortedPriceDraft("");
      setAssortedIsbn("");
      setAssortedNotInList(false);
      setAssortedOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [checkoutOpen, assortedOpen, duplicate]);

  // Every editable input fills the full width of its column, so its box lines
  // up under the column header. Text alignment and unit padding are added per
  // field; the ₹ / % adornments are positioned inside the box, not beside it.
  const cell =
    "w-full rounded-md border border-neutral-300 bg-white py-1 tnum outline-none transition focus:border-accent focus:bg-accent/5 focus:ring-2 focus:ring-accent/30 xl:text-base";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 xl:gap-7">
      {/* Scan bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 print:hidden xl:gap-4">
        <div className="min-w-72 flex-1">
          <label htmlFor="scan" className="sr-only">
            Scan barcode or type an ISBN
          </label>
          <input
            id="scan"
            ref={scanRef}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            inputMode="numeric"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setStatus(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void lookupAndAdd(query);
              }
            }}
            placeholder="Scan barcode or type an ISBN, then press Enter"
            className="w-full rounded-xl border-2 border-accent/30 bg-white px-4 py-3.5 text-base outline-none transition placeholder:text-neutral-400 focus:border-accent focus:ring-4 focus:ring-accent/10 xl:px-5 xl:py-4 xl:text-lg"
          />
        </div>

        <button
          type="button"
          onClick={() => openAssorted("assorted-books")}
          className="rounded-xl border border-accent/40 px-3 py-2.5 text-sm font-medium text-accent transition hover:bg-accent/5 xl:py-3"
        >
          + Assorted book <span className="text-neutral-400">(F3)</span>
        </button>
        <button
          type="button"
          onClick={() => openAssorted("assorted-stationery")}
          className="rounded-xl border border-accent/40 px-3 py-2.5 text-sm font-medium text-accent transition hover:bg-accent/5 xl:py-3"
        >
          + Assorted stationery <span className="text-neutral-400">(F4)</span>
        </button>

        <div className="flex items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 xl:px-4 xl:py-3">
          <label
            htmlFor="default-discount"
            className="text-xs font-medium uppercase tracking-wide text-neutral-500 xl:text-sm"
          >
            Default discount
          </label>
          <input
            id="default-discount"
            type="number"
            min={0}
            max={MAX_DISCOUNT_PERCENT}
            step="0.5"
            value={defaultDraft}
            onChange={(event) => {
              const draft = event.target.value;
              setDefaultDraft(draft);
              setDefaultDiscount(
                clampDiscountPercent(draft.trim() === "" ? 0 : Number(draft)),
              );
            }}
            onBlur={() => setDefaultDraft(String(defaultDiscount))}
            className="w-16 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-right text-sm tnum outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/30"
          />
          <span className="text-sm text-neutral-500">%</span>
          <button
            type="button"
            onClick={applyDiscountToAll}
            disabled={lines.length === 0}
            className="ml-1 rounded-lg border border-accent/40 px-2.5 py-1 text-xs font-medium text-accent transition hover:bg-accent/5 disabled:opacity-30"
          >
            Apply to all
          </button>
        </div>
      </div>

      {/* <p
        className="-mt-2 h-fit shrink-0 text-xs print:hidden xl:text-sm"
        role="status"
        aria-live="polite"
      > */}
      {/* {busy && <span className="text-neutral-500">Looking up…</span>} */}
      {!busy && status && (
        <span
          className={
            status.tone === "error"
              ? "text-discount"
              : status.tone === "warn"
                ? "font-medium text-discount"
                : "text-neutral-500"
          }
        >
          {status.message}
        </span>
      )}
      {/* </p> */}

      {/* Bill */}
      <div className="print-plain relative flex min-h-0 flex-1 flex-col rounded-2xl border border-neutral-200 bg-white p-3 shadow-sm sm:p-4 xl:p-5">
        <div className="min-h-0 flex-1 overflow-auto print:overflow-visible">
          <table className="w-full min-w-[860px] border-collapse text-sm xl:text-base">
            <thead>
              <tr className="sticky top-0 z-10 bg-neutral-50 text-xs uppercase tracking-wide text-accent xl:text-sm">
                <th className="w-40 border border-neutral-300 px-2 py-1.5 text-left font-semibold">
                  ISBN
                </th>
                <th className="border border-neutral-300 px-2 py-1.5 text-left font-semibold">
                  Name
                </th>
                <th className="w-24 border border-neutral-300 px-2 py-1.5 text-center font-semibold">
                  Qty
                </th>
                <th className="w-32 border border-neutral-300 px-2 py-1.5 text-right font-semibold">
                  Price (MRP)
                </th>
                <th className="w-28 border border-neutral-300 px-2 py-1.5 text-right font-semibold text-discount">
                  Discount
                </th>
                <th className="w-40 border border-neutral-300 px-2 py-1.5 text-right font-semibold">
                  Price after discount
                </th>
                <th className="w-12 border border-neutral-300 px-1 py-1.5 print:hidden">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="border border-neutral-300 px-4 py-16 text-center text-neutral-400"
                  >
                    Scan a barcode to start the bill ·{" "}
                    <span className="tnum">
                      {catalogSize.toLocaleString("en-IN")}
                    </span>{" "}
                    titles in the stock list
                  </td>
                </tr>
              )}

              {lines.map((line) => {
                const { gross, off, net } = lineTotals(line);
                const tracked = line.category === "catalog";
                const short = tracked && line.qty > line.stockQty;
                const assortedLabel =
                  line.category === "assorted-stationery"
                    ? "Assorted stationery"
                    : line.category === "assorted-books"
                      ? "Assorted book"
                      : null;

                return (
                  <tr
                    key={line.id}
                    className="align-middle transition hover:bg-accent/[0.03]"
                  >
                    <td className="border border-neutral-200 px-2 py-1 tnum text-xs text-neutral-500">
                      {line.isbn || "—"}
                    </td>

                    <td className="border border-neutral-200 px-2 py-1 font-medium">
                      {line.name}
                      {assortedLabel && (
                        <span className="ml-2 rounded bg-accent/10 px-1.5 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wide text-accent">
                          {assortedLabel}
                        </span>
                      )}
                    </td>

                    <td className="border border-neutral-200 px-1.5 py-1 align-top">
                      <input
                        id={cellId(line.id, "qty")}
                        type="number"
                        min={1}
                        max={MAX_QTY}
                        step={1}
                        value={line.qtyDraft}
                        onChange={(event) =>
                          editQty(line.id, event.target.value)
                        }
                        onFocus={(event) => event.currentTarget.select()}
                        onBlur={() => commitDrafts(line.id)}
                        onKeyDown={(event) =>
                          onCellKeyDown(event, line.id, "price")
                        }
                        aria-label={`Quantity of ${line.name}`}
                        className={`${cell} px-2 text-center ${
                          short ? "border-discount" : ""
                        }`}
                      />
                      <p
                        className={`mt-0.5 text-center text-[10px] leading-tight xl:text-[11px] ${
                          short
                            ? "font-medium text-discount"
                            : "text-neutral-400"
                        }`}
                      >
                        {!tracked
                          ? "Not tracked"
                          : line.stockQty === 0
                            ? "No quantity left"
                            : short
                              ? `Only ${line.stockQty} in stock`
                              : `${line.stockQty} in stock`}
                      </p>
                    </td>

                    <td className="border border-neutral-200 px-1.5 py-1 align-top">
                      <div className="relative">
                        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-neutral-400">
                          ₹
                        </span>
                        <input
                          id={cellId(line.id, "price")}
                          type="number"
                          min={0}
                          max={MAX_PRICE_PAISE / 100}
                          step="0.01"
                          value={line.priceDraft}
                          onChange={(event) =>
                            editPrice(line.id, event.target.value)
                          }
                          onFocus={(event) => event.currentTarget.select()}
                          onBlur={() => commitDrafts(line.id)}
                          onKeyDown={(event) =>
                            onCellKeyDown(event, line.id, "discount")
                          }
                          aria-label={`Price of ${line.name} in rupees`}
                          className={`${cell} pl-6 pr-2 text-right`}
                        />
                      </div>
                      {line.qty > 1 && (
                        <p className="mt-0.5 text-right text-[10px] leading-tight text-neutral-400 xl:text-[11px]">
                          × {line.qty} = {formatPaise(gross)}
                        </p>
                      )}
                    </td>

                    <td className="border border-neutral-200 px-1.5 py-1 align-top">
                      <div className="relative">
                        <input
                          id={cellId(line.id, "discount")}
                          type="number"
                          min={0}
                          max={MAX_DISCOUNT_PERCENT}
                          step="0.5"
                          value={line.discountDraft}
                          onChange={(event) =>
                            editDiscount(line.id, event.target.value)
                          }
                          onFocus={(event) => event.currentTarget.select()}
                          onBlur={() => commitDrafts(line.id)}
                          onKeyDown={(event) =>
                            onCellKeyDown(event, line.id, "sell")
                          }
                          aria-label={`Discount percent for ${line.name}`}
                          className={`${cell} pl-2 pr-7 text-right`}
                        />
                        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400">
                          %
                        </span>
                      </div>
                      {off > 0 && (
                        <p className="mt-0.5 text-right text-[10px] font-medium leading-tight text-discount xl:text-[11px]">
                          −{formatPaise(off)}
                        </p>
                      )}
                      {line.defaultDiscountPercent !== null && (
                        <p
                          className="mt-0.5 text-right text-[10px] leading-tight text-neutral-400 xl:text-[11px]"
                          title="This title has its own default discount and is skipped by “Apply to all”."
                        >
                          fixed default {line.defaultDiscountPercent}%
                        </p>
                      )}
                    </td>

                    <td className="border border-neutral-200 px-2 py-1 text-right tnum font-semibold">
                      {formatPaise(net)}
                    </td>

                    <td className="border border-neutral-200 px-1 text-center align-middle print:hidden">
                      <button
                        type="button"
                        onClick={() => removeLine(line.id)}
                        aria-label={`Remove ${line.name}`}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-discount text-white transition hover:bg-discount/85"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="h-4 w-4"
                          aria-hidden="true"
                        >
                          <path d="M3 6h18" />
                          <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                          <path d="M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6" />
                          <path d="M10 11v6M14 11v6" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Totals */}
        <div className="mt-4 flex absolute w-fit p-2 bg-white right-8 bottom-8 shrink-0 justify-end">
          <div className="w-full max-w-sm rounded-2xl border-2 border-accent/20 bg-neutral-50 p-4 print:bg-white xl:max-w-md xl:p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-accent xl:text-base">
              Total
            </h2>

            <dl className="mt-3 space-y-1.5 text-sm xl:text-base">
              <div className="flex justify-between gap-4">
                <dt className="text-neutral-500">
                  Total before discount
                  {totals.units > 0 && (
                    <span className="text-neutral-400">
                      {" "}
                      · {totals.units} item{totals.units === 1 ? "" : "s"}
                    </span>
                  )}
                </dt>
                <dd className="tnum">{formatPaise(totals.before)}</dd>
              </div>

              <div className="flex justify-between gap-4">
                <dt className="text-discount">Discount amount</dt>
                <dd className="tnum text-discount">
                  −{formatPaise(totals.discount)}
                </dd>
              </div>

              <div className="mt-2 flex items-baseline justify-between gap-4 border-t-2 border-accent/20 pt-2">
                <dt className="text-base font-semibold text-accent xl:text-lg">
                  Total after discount
                </dt>
                <dd className="tnum text-2xl font-bold text-accent xl:text-3xl">
                  {formatPaise(totals.after)}
                </dd>
              </div>
            </dl>

            {totals.short > 0 && (
              <p className="mt-3 rounded-lg bg-discount/10 px-3 py-2 text-xs text-discount xl:text-sm">
                {totals.short} item{totals.short === 1 ? "" : "s"} exceed the
                recorded stock. You can still complete the sale.
              </p>
            )}

            <div className="mt-4 flex gap-2 print:hidden">
              <button
                id={SELL_BUTTON_ID}
                type="button"
                onClick={openCheckout}
                disabled={lines.length === 0}
                className="flex-1 rounded-xl bg-accent px-3 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-accent/90 focus:outline-none focus:ring-4 focus:ring-accent/30 disabled:opacity-30 xl:text-base"
              >
                Sell
              </button>
              <button
                type="button"
                onClick={newSale}
                disabled={lines.length === 0}
                className="rounded-xl border border-neutral-300 px-3 py-2.5 text-sm text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-30 xl:text-base"
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      </div>

      {duplicate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 print:hidden"
          onMouseDown={cancelDuplicate}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="Book already added"
            onKeyDown={onDuplicateKeyDown}
            onMouseDown={(event) => event.stopPropagation()}
            className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-2xl outline-none"
          >
            <h2 className="text-lg font-bold tracking-tight">
              Already on the <span className="text-accent">bill</span>
            </h2>
            <p className="mt-2 text-sm text-neutral-600">
              <span className="font-medium">{duplicate.name}</span> is already
              added. Update its quantity instead?
            </p>

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={cancelDuplicate}
                className="flex-1 rounded-xl border border-neutral-300 px-3 py-2.5 text-sm text-neutral-600 transition hover:bg-neutral-100"
              >
                Cancel
              </button>
              <button
                ref={duplicateBtnRef}
                type="button"
                onClick={confirmDuplicate}
                className="flex-1 rounded-xl bg-accent px-3 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-accent/90 focus:outline-none focus:ring-4 focus:ring-accent/30"
              >
                Update quantity
              </button>
            </div>
            <p className="mt-2 text-xs text-neutral-400">
              Enter to update · Esc to cancel
            </p>
          </div>
        </div>
      )}

      {assortedOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 print:hidden"
          onMouseDown={closeAssorted}
        >
          <div
            ref={assortedRef}
            role="dialog"
            aria-modal="true"
            aria-label="Add assorted item"
            onKeyDown={onAssortedKeyDown}
            onMouseDown={(event) => event.stopPropagation()}
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl outline-none"
          >
            <h2 className="text-lg font-bold tracking-tight">
              {assortedNotInList ? (
                <>
                  Not in list —{" "}
                  <span className="text-accent">add as assorted</span>
                </>
              ) : (
                <>
                  Add <span className="text-accent">assorted item</span>
                </>
              )}
            </h2>
            <p className="mt-1 text-sm text-neutral-500">
              {assortedNotInList
                ? "This ISBN isn’t in the stock list. Add it as an assorted item to keep selling."
                : "Pick a category and enter a price. The name is optional."}
            </p>

            <div className="mt-4 grid grid-cols-2 gap-2">
              {(
                [
                  ["assorted-books", "Books"],
                  ["assorted-stationery", "Stationery"],
                ] as const
              ).map(([cat, label]) => {
                const selected = assortedCategory === cat;
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setAssortedCategory(cat)}
                    className={`rounded-xl border-2 px-3 py-3 text-sm font-semibold transition ${
                      selected
                        ? "border-accent bg-accent text-white"
                        : "border-neutral-200 bg-white text-neutral-600 hover:border-accent/40"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <label
              htmlFor="assorted-isbn"
              className="mt-4 block text-xs font-medium uppercase tracking-wide text-neutral-500"
            >
              ISBN / barcode (optional)
            </label>
            <input
              id="assorted-isbn"
              value={assortedIsbn}
              onChange={(event) => setAssortedIsbn(event.target.value)}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              maxLength={20}
              placeholder="Scan or type a code"
              className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm tnum outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/30"
            />

            <label
              htmlFor="assorted-name"
              className="mt-3 block text-xs font-medium uppercase tracking-wide text-neutral-500"
            >
              Name (optional)
            </label>
            <input
              id="assorted-name"
              value={assortedName}
              onChange={(event) => setAssortedName(event.target.value)}
              maxLength={120}
              placeholder={defaultAssortedName(assortedCategory)}
              className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/30"
            />

            <label
              htmlFor="assorted-price"
              className="mt-3 block text-xs font-medium uppercase tracking-wide text-neutral-500"
            >
              Price (₹)
            </label>
            <input
              id="assorted-price"
              ref={assortedPriceRef}
              type="number"
              min={0}
              step="0.01"
              max={MAX_PRICE_PAISE / 100}
              value={assortedPriceDraft}
              onChange={(event) => setAssortedPriceDraft(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              placeholder="0.00"
              className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-right tnum outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/30"
            />

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={saveAssorted}
                disabled={!assortedPriceValid}
                className="flex-1 rounded-xl bg-accent px-3 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-accent/90 focus:outline-none focus:ring-4 focus:ring-accent/30 disabled:opacity-40"
              >
                Add to bill
              </button>
              <button
                type="button"
                onClick={closeAssorted}
                className="rounded-xl border border-neutral-300 px-4 py-3 text-sm text-neutral-600 transition hover:bg-neutral-100"
              >
                Cancel
              </button>
            </div>
            <p className="mt-2 text-xs text-neutral-400">
              Enter to add · Esc to cancel
            </p>
          </div>
        </div>
      )}

      {checkoutOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 print:hidden"
          onMouseDown={closeCheckout}
        >
          <div
            ref={checkoutRef}
            role="dialog"
            aria-modal="true"
            aria-label="Choose payment method"
            tabIndex={-1}
            onKeyDown={onCheckoutKeyDown}
            onMouseDown={(event) => event.stopPropagation()}
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl outline-none"
          >
            <h2 className="text-lg font-bold tracking-tight">
              Payment <span className="text-accent">method</span>
            </h2>
            <p className="mt-1 text-sm text-neutral-500">
              ← → to switch · Enter to confirm · Esc to cancel
            </p>

            <div
              role="tablist"
              aria-label="Payment method"
              className="mt-4 grid grid-cols-3 gap-2"
            >
              {PAYMENT_METHODS.map((method, i) => {
                const selected = i === paymentIndex;
                return (
                  <button
                    key={method}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    tabIndex={-1}
                    onClick={() => setPaymentIndex(i)}
                    className={`rounded-xl border-2 px-3 py-4 text-sm font-semibold transition ${
                      selected
                        ? "border-accent bg-accent text-white shadow-sm"
                        : "border-neutral-200 bg-white text-neutral-600 hover:border-accent/40"
                    }`}
                  >
                    {method}
                  </button>
                );
              })}
            </div>

            <div className="mt-5 rounded-xl border-2 border-accent/20 bg-neutral-50 p-4">
              <div className="flex justify-between text-sm text-neutral-500">
                <span>
                  {totals.units} item{totals.units === 1 ? "" : "s"}
                </span>
                <span className="tnum">{formatPaise(totals.before)}</span>
              </div>
              <div className="mt-1 flex justify-between text-sm text-discount">
                <span>Discount</span>
                <span className="tnum">−{formatPaise(totals.discount)}</span>
              </div>
              <div className="mt-2 flex items-baseline justify-between border-t-2 border-accent/20 pt-2">
                <span className="font-semibold text-accent">Total to pay</span>
                <span className="tnum text-2xl font-bold text-accent">
                  {formatPaise(totals.after)}
                </span>
              </div>
            </div>

            {checkoutError && (
              <p className="mt-3 rounded-lg bg-discount/10 px-3 py-2 text-sm text-discount">
                {checkoutError}
              </p>
            )}

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => void confirmSale()}
                disabled={submitting}
                className="flex-1 rounded-xl bg-accent px-3 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-accent/90 focus:outline-none focus:ring-4 focus:ring-accent/30 disabled:opacity-50"
              >
                {submitting
                  ? "Recording…"
                  : `Confirm & pay by ${PAYMENT_METHODS[paymentIndex]}`}
              </button>
              <button
                type="button"
                onClick={closeCheckout}
                disabled={submitting}
                className="rounded-xl border border-neutral-300 px-4 py-3 text-sm text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
