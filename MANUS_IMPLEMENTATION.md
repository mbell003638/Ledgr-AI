# Ledgr Manus Branch

## Product direction

The `Manus` branch introduces a **primary persona plus optional capability packs** model. A persona selects a focused starting workspace, while capability packs can be enabled later from Workspace Capabilities. Hidden packs do not delete data; they remove entry points until re-enabled.

## Capability behavior

Capability resolution is centralized in `frontend/src/utils/capabilities.ts`. Home tiles, global quick actions, onboarding previews, capability settings, and authenticated routes use the same registry. Legacy persona IDs and legacy feature overrides remain supported for existing books.

Multi-location retail is deliberately **opt-in**. Retail onboarding can enable it when the business operates multiple stores or POS points. When enabled, Ledgr exposes Locations, POS Sessions, Stock Transfers, location/POS assignment on sales and invoices, and the corresponding local collections and backup lifecycle.

## Accounting trust surfaces

The Home screen now includes a focused workspace identity and Book Health summary. Book Health checks for incomplete business setup, invoice drafts, missing dates, open POS sessions, and the absence of a recorded backup export. Existing V2 journal reversal, closed-period protection, posting invariants, and AI review-confirmation paths remain authoritative.

## Metric behavior

`frontend/src/utils/metrics.ts` provides explainable, input-aware calculations for COGS, gross margin, CAC, RTO, ROI, ROE, and PEG. A metric returns `insufficient_data` rather than displaying a misleading value when its required inputs are unavailable.

## Validation

The final branch passed:

- `npm run lint:ci`
- `npx tsc --noEmit`
- `npx expo-doctor`
- `npx expo export --platform android --output-dir /tmp/ledgr-manus-export`
- `npx jest --ci --runInBand` — 74 suites and 563 tests
