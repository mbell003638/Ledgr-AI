# 9th audit — optional payroll, fixed assets, live stock (`f99d87c` → this close-out)

**Date:** 2026-08-13  
**Branch:** `codex-sol`  
**Audited commit:** `f99d87c` `feat(optional): add payroll, fixed-asset register, and live product stock`  
**This close-out:** local fixes on top of `f99d87c`, then pushed with this report  
**Mode:** Full audit of the optional modules. Every finding in §4 was fixed in the same pass (six parallel fix agents). This file is the report of what was found **and** what was fixed.

---

## 1. What was audited

Optional modules added in `f99d87c`:

- Payroll (employees, pay runs, withholdings, payslips, year-end **summary**)
- Fixed asset register (acquire, straight-line depreciation, dispose)
- Live product stock (qty on each product; sale/purchase moves)

Also checked: feature flags (off until Customize Features), schema v6, reset/backup wipe order, dashboard tiles, stack routes, interaction with periodic COGS / period close.

Persona baselines still **exclude** these three keys. Existing shops keep periodic counts unless they turn live stock on.

---

## 2. Verdict

The optional modules were a real, gated slice — but `f99d87c` shipped several P0/P1 holes.

This pass found them **all at once**, fixed them, and verified with full Jest (`73` suites / `556` tests) and `tsc`.

After this close-out there is **no remaining application leftover** from this audit of the optional modules.

What is *not* claimed: official tax-office e-filing, FIFO costing, or a device walkthrough of the new screens.

---

## 3. Findings (found) and resolutions (fixed)

### 3.1 P0 — Delete/edit sale, invoice, or bill left product qty wrong

**Found:** `applySaleLines` / `applyPurchaseLines` changed `v2_products.qty` and wrote `v2_stock_moves`. `reverseSource` / `replaceSource` reversed journals only. Delete a 3-unit sale and the shelf still showed 3 gone.

**Fixed:** `ProductDomainService.reverseMovesForSource` restores qty (sale +, purchase −, adjust undo signed qty) and deletes those moves. `documentService.reverseSource` and `replaceSource` call it. Create hooks persist `productLines` on source metadata so a recreate can re-apply. Tests: sale 10→7 then reverse → 10; purchase reverse restores qty.

### 3.2 P0 — Periodic COGS + live-stock COGS double-counted

**Found:** A product sale already posts Dr 5000 / Cr 1200. Close still posted periodic COGS (`opening + purchases − count`). Open-period reports injected the same estimate. Two COGS hits for one sale.

**Fixed:** When `perpetualInventory` is on, close **skips** the periodic COGS journal; snapshot `cogs` is the period’s posted 5000 movement. `openPeriodCogsAdjustment` returns nothing. Periodic path is unchanged when the module is off. Tests: sale COGS 15 stays 15 on reports and after close with a count.

### 3.3 P1 — Dispose did not write off the asset

**Found:** UI said remaining book value would be written off. `disposeAsset` only set `disposed=1`. Cost stayed on 1400.

**Fixed:** Dispose posts `asset_disposal`: Dr 1450 accum (if any), Dr 6300 NBV (if any), Cr 1400 cost, then marks disposed. Test: after one month of dep, dispose clears 1400.

### 3.4 P1 — Same month could be depreciated twice

**Found:** `postDepreciation` had no YYYY-MM guard.

**Fixed:** Second post in the same calendar month throws `Depreciation already posted for this month`. Test added.

### 3.5 P1 — Year-end payroll `LIKE '%'` / `$0` slips

**Found:** `yearEndSummary('')` became `date LIKE '%'`, summing every year. Zero-rate employees still got $0 payslips.

**Fixed:** Year must be `YYYY`. Zero-gross employees are skipped; if none remain, throw. Screen validates four digits. Tests: `'202'` and `''` throw; a 2026 run is absent from 2025.

### 3.6 P2 — Opening stock used a UTC calendar day

**Found:** Fallback date was `toISOString().slice(0, 10)`.

**Fixed:** Period start, else `localTodayIso()`.

### 3.7 P2 — Backup wipe lists could drift from `V2_TABLES`

**Found:** Orders already matched; no missing table. Drift was possible later.

**Fixed:** Runtime guard on wipe (same idea as factory reset) plus tests that `DELETE_ORDER` / `INSERT_ORDER` / `V2_COLLECTIONS` equal `V2_TABLES`.

### Already correct (no code change)

- Modules stay off until Customize Features (`OPTIONAL_FEATURE_KEYS` not in persona baselines).
- Feature writes gated by `isOptionalModuleEnabled`.
- Payroll journal: Dr 6200, Cr cash/bank, Cr 2310.
- Acquire asset: Dr 1400, Cr cash/bank/2500.
- Sale/bill UI does not send `productLines` on edit.
- Reset / delete book / factory already wiped the new tables.

---

## 4. How to use (unchanged product intent)

**Customize Features** → enable Payroll, Fixed Asset Register, and/or Live Product Stock.

- Payroll tile → employees, run pay, payslips, year-end **summary** (not a tax-office filing).
- Fixed Assets tile → register, monthly SL depreciation, dispose with write-off.
- Products tile → SKUs and qty. Pick a product on a new sale/bill to move stock. No product = service sale as before. Stock tile still does period counts.

---

## 5. Verification

```text
cd frontend
npx tsc --noEmit
npx jest --ci --runInBand
```

| Check | Result |
|---|---|
| TypeScript | 0 errors |
| Jest | **73 suites, 556 tests** (was 547 on `f99d87c`) |
| Device walkthrough | Not done |

---

## 6. Out of this slice (not leftover bugs)

- Official payroll/tax **e-filing**
- FIFO / average costing (live stock uses the product’s stored unit cost)
- Multi-user permissions
- Earlier product gaps (FX, bank rec, etc.)

---

## 7. Method

- Four read-only auditors (payroll, assets, perpetual, flags/schema)
- Six fix agents (stock reverse, skip periodic COGS, dispose + monthly dep, payroll year, dates/UI, backup coverage)
- Parent review, `tsc`, full Jest, then commit + push with this report

**Bottom line:** The optional modules in `f99d87c` were audited as a whole. Qty-on-delete, double COGS, dispose write-off, double monthly dep, and year-end payroll holes are fixed and tested. Nothing from this 9th-audit list is left open in application source.
