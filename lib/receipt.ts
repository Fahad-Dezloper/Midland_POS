import type { BillSource } from "./bill-source";
import type { ItemCategory } from "./categories";
import { formatPaise } from "./money";
import type { PaymentMethod } from "./payment";

/**
 * Client-safe receipt building. No Node imports, so it can be bundled into the
 * browser and reused by both the sale terminal and the bills manager.
 */

export type ReceiptBill = {
  orderId: string;
  soldAt: string;
  updatedAt?: string;
  source?: BillSource;
  paymentMethod: PaymentMethod;
  lines: {
    isbn: string;
    name: string;
    category: ItemCategory;
    qty: number;
    unitPricePaise: number;
    discountPercent: number;
    grossPaise: number;
    discountPaise: number;
    netPaise: number;
    gstPercent?: number | null;
  }[];
  totals: {
    beforePaise: number;
    discountPaise: number;
    afterPaise: number;
    units: number;
  };
};

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] as string,
  );

/** Builds the self-contained HTML document for a receipt. */
function buildReceiptHtml(sale: ReceiptBill): string {
  const when = new Date(sale.soldAt).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const rows = sale.lines
    .map(
      (l) => `
      <tr>
        <td>${escapeHtml(l.name)}<div class="isbn">${escapeHtml(l.isbn || "—")}</div>${
          l.gstPercent != null
            ? `<div class="gst">Incl. GST ${l.gstPercent}%</div>`
            : ""
        }</td>
        <td class="num">${l.qty}</td>
        <td class="num">${formatPaise(l.unitPricePaise)}</td>
        <td class="num">${l.discountPercent}%</td>
        <td class="num">${formatPaise(l.netPaise)}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Receipt ${escapeHtml(sale.orderId)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, Arial, sans-serif; color: #0a0a0a; max-width: 640px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 20px; margin: 0; }
  h1 span { color: #1d4ed8; }
  .meta { color: #555; font-size: 13px; margin-top: 4px; }
  .meta b { color: #0a0a0a; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 14px; }
  th, td { border-bottom: 1px solid #e5e5e5; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { color: #1d4ed8; text-transform: uppercase; font-size: 11px; letter-spacing: .04em; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .isbn { color: #888; font-size: 11px; font-variant-numeric: tabular-nums; }
  .gst { color: #1d4ed8; font-size: 11px; font-weight: 600; }
  .totals { margin-top: 16px; margin-left: auto; width: 260px; font-size: 14px; }
  .totals div { display: flex; justify-content: space-between; padding: 2px 0; }
  .totals .discount { color: #ef4444; }
  .totals .grand { border-top: 2px solid #1d4ed8; margin-top: 6px; padding-top: 6px; font-weight: 700; font-size: 18px; color: #1d4ed8; }
  .pay { margin-top: 16px; font-size: 14px; }
  .pay b { color: #1d4ed8; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
  <h1>Midland <span>Sales Report</span></h1>
  <div class="meta">
    Order <b>${escapeHtml(sale.orderId)}</b><br/>
    ${escapeHtml(when)}
  </div>
  <table>
    <thead>
      <tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Disc</th><th class="num">Total</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="totals">
    <div><span>Total before discount</span><span>${formatPaise(sale.totals.beforePaise)}</span></div>
    <div class="discount"><span>Discount</span><span>-${formatPaise(sale.totals.discountPaise)}</span></div>
    <div class="grand"><span>Total</span><span>${formatPaise(sale.totals.afterPaise)}</span></div>
  </div>
  <div class="pay">Paid by <b>${escapeHtml(sale.paymentMethod)}</b> · ${sale.totals.units} item${sale.totals.units === 1 ? "" : "s"}${
    sale.source === "event" ? ' · <b>Event sale</b>' : ""
  }</div>
</body>
</html>`;
}

/** Builds a self-contained HTML receipt and saves it to the user's machine. */
export function downloadReceipt(sale: ReceiptBill) {
  const html = buildReceiptHtml(sale);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `receipt-${sale.orderId}.html`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * Opens the browser's print dialog for the receipt, sending it straight to the
 * connected printer. The receipt is rendered into an off-screen iframe so the
 * POS page itself is never disturbed; the iframe is cleaned up after printing.
 */
export function printReceipt(sale: ReceiptBill) {
  const html = buildReceiptHtml(sale);

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.style.visibility = "hidden";

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    iframe.remove();
  };

  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) {
      cleanup();
      return;
    }
    // Remove the iframe once the print dialog is dismissed. A long fallback
    // covers browsers that never fire `afterprint`.
    win.onafterprint = () => window.setTimeout(cleanup, 200);
    window.setTimeout(cleanup, 60_000);
    win.focus();
    win.print();
  };

  document.body.appendChild(iframe);
  iframe.srcdoc = html;
}
