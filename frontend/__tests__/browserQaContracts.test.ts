import * as fs from "fs";
import * as path from "path";

const root = path.join(__dirname, "..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("browser QA regression contracts", () => {
  it("keeps Reports truthful and usable on web without invoking native V2 reports", () => {
    const reports = read("app/(tabs)/reports.tsx");
    expect(reports).toContain('import * as localDb from "@/src/db/local";');
    expect(reports).toContain('if (Platform.OS === "web")');
    expect(reports).toContain("localDb.pnlRange(from, to)");
    expect(reports).toContain("Browser local summary");
    expect(reports).toContain("Native SQLite reports and location-scoped ledger filters are available in the mobile app.");
    expect(reports).toContain('isCapabilityEnabled(s, "multi_location")');
    expect(reports).toContain('api.listLocations()');
    expect(reports).toContain('locationRail');
    expect(reports).toContain('minWidth: 118');
    expect(reports).toContain('flexShrink: 0');
    expect(reports).toContain('accessibilityLabel="All locations"');
  });

  it("routes browser transaction reads and writes through legacy local storage", () => {
    const api = read("src/api.ts");
    for (const method of ["listBills", "listSales", "listPayments", "listInvoices", "listReceipts", "listExpenses"]) {
      expect(api).toContain(method);
    }
    expect(api).toContain("isWebRuntime ? db.createBill");
    expect(api).toContain("isWebRuntime ? db.createSale");
    expect(api).toContain("isWebRuntime ? db.createPayment");
    expect(api).toContain("isWebRuntime ? db.createInvoice");
    expect(api).toContain("isWebRuntime ? db.createReceipt");
    expect(api).toContain("isWebRuntime ? db.createExpense");
    expect(api).toContain("if (isWebRuntime) return db.listSuppliers();");
    expect(api).toContain("if (isWebRuntime) return db.listDebtors();");
  });

  it("prevents direct customer links from landing on an unmatched route", () => {
    const route = read("app/customers.tsx");
    expect(route).toContain('router.replace("/suppliers")');
    expect(route).toContain('pathname: "/customer/[id]"');
  });

  it("labels transaction and Quick Action controls for browser accessibility", () => {
    expect(read("app/invoices.tsx")).toContain('accessibilityLabel="Create invoice"');
    expect(read("app/payments.tsx")).toContain('accessibilityLabel="Create payment"');
    expect(read("app/expenses.tsx")).toContain('accessibilityLabel="Create expense"');
    const quick = read("src/components/QuickActionMenu.tsx");
    expect(quick).toContain('accessibilityRole="button"');
    expect(quick).toContain("accessibilityLabel={title}");
    expect(quick).toContain('accessibilityLabel="Scan receipt or ask AI"');
  });
});
