import { round2 } from "@/src/money";

export type InvoiceTotalLine = {
  qty?: number | string;
  rate?: number | string;
  price?: number | string;
};

export type InvoiceTotals = {
  subtotal: number;
  discount: number;
  taxableSubtotal: number;
  tax: number;
  total: number;
};

/** One calculation shared by quick sales, invoices, edits, and documents. */
export function calculateInvoiceTotals(
  lines: InvoiceTotalLine[],
  discountValue: number | string = 0,
  taxRateValue: number | string = 0,
): InvoiceTotals {
  const subtotal = round2(lines.reduce((sum, line) => {
    const qty = Number(line.qty ?? 1);
    const rate = Number(line.rate ?? line.price ?? 0);
    return sum + (Number.isFinite(qty) ? qty : 0) * (Number.isFinite(rate) ? rate : 0);
  }, 0));
  const discount = round2(Number(discountValue) || 0);
  const taxRate = Number(taxRateValue) || 0;
  if (discount < 0) throw new Error("Discount cannot be negative");
  if (discount > subtotal + 0.005) throw new Error("Discount cannot exceed subtotal");
  if (taxRate < 0) throw new Error("Tax rate cannot be negative");
  const taxableSubtotal = round2(subtotal - discount);
  const tax = round2(taxableSubtotal * taxRate / 100);
  return { subtotal, discount, taxableSubtotal, tax, total: round2(taxableSubtotal + tax) };
}
