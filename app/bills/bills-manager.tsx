"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { categoryLabel } from "@/lib/categories";
import {
  MAX_DISCOUNT_PERCENT,
  MAX_QTY,
  clampDiscountPercent,
  clampQty,
  formatPaise,
  lineAmounts,
  paiseToRupeesInput,
  parseRupeesToPaise,
} from "@/lib/money";
import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/payment";
import { type ReceiptBill, downloadReceipt } from "@/lib/receipt";

type Bill = ReceiptBill;

/** A line while it is being edited, with raw draft strings for each field. */
type EditLine = {
  isbn: string;
  name: string;
  category: Bill["lines"][number]["category"];
  qty: number;
  qtyDraft: string;
  unitPricePaise: number;
  priceDraft: string;
  discountPercent: number;
  discountDraft: string;
};

type EditState = {
  orderId: string;
  paymentMethod: PaymentMethod;
  lines: EditLine[];
  saving: boolean;
  error: string | null;
};

function toEditLines(bill: Bill): EditLine[] {
  return bill.lines.map((l) => ({
    isbn: l.isbn,
    name: l.name,
    category: l.category,
    qty: l.qty,
    qtyDraft: String(l.qty),
    unitPricePaise: l.unitPricePaise,
    priceDraft: paiseToRupeesInput(l.unitPricePaise),
    discountPercent: l.discountPercent,
    discountDraft: String(l.discountPercent),
  }));
}

async function fetchBills(): Promise<Bill[]> {
  const res = await fetch("/api/bills", { cache: "no-store" });
  if (!res.ok) throw new Error("Could not load bills");
  const data: { bills?: Bill[] } = await res.json();
  return Array.isArray(data.bills) ? data.bills : [];
}

function billTotals(lines: { unitPricePaise: number; qty: number; discountPercent: number }[]) {
  let before = 0;
  let discount = 0;
  let units = 0;
  for (const l of lines) {
    const { gross, off } = lineAmounts(l.unitPricePaise, l.qty, l.discountPercent);
    before += gross;
    discount += off;
    units += l.qty;
  }
  return { before, discount, after: before - discount, units };
}

export default function BillsManager() {
  const [bills, setBills] = useState<Bill[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setBills(await fetchBills());
      setLoadError(null);
    } catch {
      setBills([]);
      setLoadError("Could not load bills.");
    }
  }, []);

  // Load once on mount. State is only touched after the awaited fetch resolves.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchBills();
        if (!cancelled) {
          setBills(data);
          setLoadError(null);
        }
      } catch {
        if (!cancelled) {
          setBills([]);
          setLoadError("Could not load bills.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const startEdit = (bill: Bill) => {
    setNotice(null);
    setEdit({
      orderId: bill.orderId,
      paymentMethod: bill.paymentMethod,
      lines: toEditLines(bill),
      saving: false,
      error: null,
    });
  };

  const cancelEdit = () => setEdit(null);

  const patchEditLine = (index: number, patch: (line: EditLine) => EditLine) => {
    setEdit((current) =>
      current
        ? {
            ...current,
            lines: current.lines.map((l, i) => (i === index ? patch(l) : l)),
          }
        : current,
    );
  };

  const editPreview = useMemo(
    () => (edit ? billTotals(edit.lines) : null),
    [edit],
  );

  const saveEdit = async () => {
    if (!edit || edit.saving) return;
    if (edit.lines.length === 0) {
      setEdit({ ...edit, error: "A bill needs at least one line." });
      return;
    }

    setEdit({ ...edit, saving: true, error: null });
    try {
      const res = await fetch(`/api/bills/${encodeURIComponent(edit.orderId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentMethod: edit.paymentMethod,
          lines: edit.lines.map((l) => ({
            isbn: l.isbn,
            name: l.name,
            category: l.category,
            qty: l.qty,
            unitPricePaise: l.unitPricePaise,
            discountPercent: l.discountPercent,
          })),
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setEdit((c) =>
          c ? { ...c, saving: false, error: data.error ?? "Could not save." } : c,
        );
        return;
      }

      const updated: Bill = await res.json();
      setBills((current) =>
        current
          ? current.map((b) => (b.orderId === updated.orderId ? updated : b))
          : current,
      );
      setEdit(null);
      setNotice(`Bill ${updated.orderId} updated.`);
    } catch {
      setEdit((c) =>
        c ? { ...c, saving: false, error: "Network error. Try again." } : c,
      );
    }
  };

  const deleteBill = async (orderId: string) => {
    if (deletingId) return;
    if (!window.confirm(`Delete bill ${orderId}? This cannot be undone.`)) return;

    setDeletingId(orderId);
    setNotice(null);
    try {
      const res = await fetch(`/api/bills/${encodeURIComponent(orderId)}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setNotice(data.error ?? "Could not delete the bill.");
        return;
      }
      setBills((current) =>
        current ? current.filter((b) => b.orderId !== orderId) : current,
      );
      if (edit?.orderId === orderId) setEdit(null);
      setNotice(`Bill ${orderId} deleted.`);
    } catch {
      setNotice("Network error. Try again.");
    } finally {
      setDeletingId(null);
    }
  };

  const grandTotal = useMemo(
    () => (bills ? bills.reduce((s, b) => s + b.totals.afterPaise, 0) : 0),
    [bills],
  );

  const fieldClass =
    "w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-right tnum outline-none transition focus:border-accent focus:bg-accent/5 focus:ring-2 focus:ring-accent/30";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-neutral-500">
          {bills === null
            ? "Loading…"
            : `${bills.length} bill${bills.length === 1 ? "" : "s"} · ${formatPaise(grandTotal)} total`}
        </div>
        <div className="flex items-center gap-3">
          {notice && <span className="text-sm text-neutral-500">{notice}</span>}
          <button
            type="button"
            onClick={() => void reload()}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 transition hover:bg-neutral-100"
          >
            Refresh
          </button>
        </div>
      </div>

      {loadError && (
        <p className="shrink-0 rounded-lg bg-discount/10 px-3 py-2 text-sm text-discount">
          {loadError}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {bills && bills.length === 0 && !loadError && (
          <div className="rounded-2xl border border-neutral-200 bg-white p-10 text-center text-neutral-400">
            No bills yet.
          </div>
        )}

        <ul className="flex flex-col gap-3">
          {bills?.map((bill) => {
            const isEditing = edit?.orderId === bill.orderId;
            return (
              <li
                key={bill.orderId}
                className="rounded-2xl border border-neutral-200 bg-white shadow-sm"
              >
                {/* Header row */}
                <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="tnum text-sm font-semibold text-accent">
                      {bill.orderId}
                    </div>
                    <div className="text-xs text-neutral-500">
                      {new Date(bill.soldAt).toLocaleString("en-IN", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                      {bill.updatedAt && " · edited"}
                      {" · "}
                      {bill.paymentMethod}
                      {" · "}
                      {bill.totals.units} item{bill.totals.units === 1 ? "" : "s"}
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="tnum text-lg font-bold text-accent">
                      {formatPaise(bill.totals.afterPaise)}
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => downloadReceipt(bill)}
                        className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 transition hover:bg-neutral-100"
                      >
                        Receipt
                      </button>
                      <button
                        type="button"
                        onClick={() => (isEditing ? cancelEdit() : startEdit(bill))}
                        className="rounded-lg border border-accent/40 px-3 py-1.5 text-sm font-medium text-accent transition hover:bg-accent/5"
                      >
                        {isEditing ? "Close" : "Edit"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteBill(bill.orderId)}
                        disabled={deletingId === bill.orderId}
                        className="rounded-lg border border-discount/40 px-3 py-1.5 text-sm font-medium text-discount transition hover:bg-discount/10 disabled:opacity-40"
                      >
                        {deletingId === bill.orderId ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Read-only line summary when not editing */}
                {!isEditing && (
                  <div className="border-t border-neutral-100 px-4 py-2">
                    <ul className="text-sm text-neutral-600">
                      {bill.lines.map((l, i) => (
                        <li
                          key={`${l.isbn}-${i}`}
                          className="flex justify-between gap-4 py-0.5"
                        >
                          <span className="min-w-0 truncate">
                            {l.qty} × {l.name}
                            {l.discountPercent > 0 && (
                              <span className="text-discount">
                                {" "}
                                (−{l.discountPercent}%)
                              </span>
                            )}
                          </span>
                          <span className="tnum shrink-0">
                            {formatPaise(l.netPaise)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Editor */}
                {isEditing && edit && (
                  <div className="border-t border-neutral-100 p-4">
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[720px] border-collapse text-sm">
                        <thead>
                          <tr className="text-xs uppercase tracking-wide text-accent">
                            <th className="border border-neutral-300 px-2 py-1.5 text-left font-semibold">
                              Item
                            </th>
                            <th className="w-20 border border-neutral-300 px-2 py-1.5 text-center font-semibold">
                              Qty
                            </th>
                            <th className="w-28 border border-neutral-300 px-2 py-1.5 text-right font-semibold">
                              Price
                            </th>
                            <th className="w-24 border border-neutral-300 px-2 py-1.5 text-right font-semibold text-discount">
                              Disc %
                            </th>
                            <th className="w-32 border border-neutral-300 px-2 py-1.5 text-right font-semibold">
                              Line total
                            </th>
                            <th className="w-10 border border-neutral-300 px-1 py-1.5" />
                          </tr>
                        </thead>
                        <tbody>
                          {edit.lines.map((l, i) => {
                            const { net } = lineAmounts(
                              l.unitPricePaise,
                              l.qty,
                              l.discountPercent,
                            );
                            return (
                              <tr key={`${l.isbn}-${i}`} className="align-top">
                                <td className="border border-neutral-200 px-2 py-1">
                                  <div className="font-medium">{l.name}</div>
                                  <div className="tnum text-xs text-neutral-400">
                                    {l.isbn || "—"} · {categoryLabel(l.category)}
                                  </div>
                                </td>
                                <td className="border border-neutral-200 px-1.5 py-1">
                                  <input
                                    type="number"
                                    min={1}
                                    max={MAX_QTY}
                                    step={1}
                                    value={l.qtyDraft}
                                    onChange={(e) =>
                                      patchEditLine(i, (line) => ({
                                        ...line,
                                        qtyDraft: e.target.value,
                                        qty:
                                          e.target.value.trim() === ""
                                            ? 1
                                            : clampQty(Number(e.target.value)),
                                      }))
                                    }
                                    onFocus={(e) => e.currentTarget.select()}
                                    onBlur={() =>
                                      patchEditLine(i, (line) => ({
                                        ...line,
                                        qtyDraft: String(line.qty),
                                      }))
                                    }
                                    className={`${fieldClass} text-center`}
                                  />
                                </td>
                                <td className="border border-neutral-200 px-1.5 py-1">
                                  <input
                                    type="number"
                                    min={0}
                                    step="0.01"
                                    value={l.priceDraft}
                                    onChange={(e) =>
                                      patchEditLine(i, (line) => ({
                                        ...line,
                                        priceDraft: e.target.value,
                                        unitPricePaise: parseRupeesToPaise(
                                          e.target.value,
                                        ),
                                      }))
                                    }
                                    onFocus={(e) => e.currentTarget.select()}
                                    onBlur={() =>
                                      patchEditLine(i, (line) => ({
                                        ...line,
                                        priceDraft: paiseToRupeesInput(
                                          line.unitPricePaise,
                                        ),
                                      }))
                                    }
                                    className={fieldClass}
                                  />
                                </td>
                                <td className="border border-neutral-200 px-1.5 py-1">
                                  <input
                                    type="number"
                                    min={0}
                                    max={MAX_DISCOUNT_PERCENT}
                                    step="0.5"
                                    value={l.discountDraft}
                                    onChange={(e) =>
                                      patchEditLine(i, (line) => ({
                                        ...line,
                                        discountDraft: e.target.value,
                                        discountPercent: clampDiscountPercent(
                                          e.target.value.trim() === ""
                                            ? 0
                                            : Number(e.target.value),
                                        ),
                                      }))
                                    }
                                    onFocus={(e) => e.currentTarget.select()}
                                    onBlur={() =>
                                      patchEditLine(i, (line) => ({
                                        ...line,
                                        discountDraft: String(line.discountPercent),
                                      }))
                                    }
                                    className={fieldClass}
                                  />
                                </td>
                                <td className="border border-neutral-200 px-2 py-1 text-right tnum font-semibold">
                                  {formatPaise(net)}
                                </td>
                                <td className="border border-neutral-200 px-1 text-center align-middle">
                                  <button
                                    type="button"
                                    aria-label={`Remove ${l.name}`}
                                    onClick={() =>
                                      setEdit((c) =>
                                        c
                                          ? {
                                              ...c,
                                              lines: c.lines.filter(
                                                (_, j) => j !== i,
                                              ),
                                            }
                                          : c,
                                      )
                                    }
                                    className="rounded-md px-2 py-1 text-neutral-400 transition hover:bg-discount/10 hover:text-discount"
                                  >
                                    ✕
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
                      <div>
                        <label className="block text-xs font-medium uppercase tracking-wide text-neutral-500">
                          Payment method
                        </label>
                        <div className="mt-1 flex gap-1.5">
                          {PAYMENT_METHODS.map((method) => (
                            <button
                              key={method}
                              type="button"
                              onClick={() =>
                                setEdit((c) =>
                                  c ? { ...c, paymentMethod: method } : c,
                                )
                              }
                              className={`rounded-lg border-2 px-3 py-1.5 text-sm font-medium transition ${
                                edit.paymentMethod === method
                                  ? "border-accent bg-accent text-white"
                                  : "border-neutral-200 text-neutral-600 hover:border-accent/40"
                              }`}
                            >
                              {method}
                            </button>
                          ))}
                        </div>
                      </div>

                      {editPreview && (
                        <div className="text-right text-sm">
                          <div className="text-neutral-500">
                            Before {formatPaise(editPreview.before)} · Discount{" "}
                            <span className="text-discount">
                              −{formatPaise(editPreview.discount)}
                            </span>
                          </div>
                          <div className="tnum text-xl font-bold text-accent">
                            {formatPaise(editPreview.after)}
                          </div>
                        </div>
                      )}
                    </div>

                    {edit.error && (
                      <p className="mt-3 rounded-lg bg-discount/10 px-3 py-2 text-sm text-discount">
                        {edit.error}
                      </p>
                    )}

                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void saveEdit()}
                        disabled={edit.saving || edit.lines.length === 0}
                        className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-accent/90 disabled:opacity-40"
                      >
                        {edit.saving ? "Saving…" : "Save changes"}
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="rounded-xl border border-neutral-300 px-4 py-2 text-sm text-neutral-600 transition hover:bg-neutral-100"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
