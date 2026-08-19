# Manus Branch Remediation Specialist Team

## Mandate

This remediation corrects the user-reported workflow regressions in the existing `Manus` branch. The team works from the current app behavior and screenshots: Home must not display unselected operational metrics, onboarding must ask which eligible metrics belong in Reports, legacy finance operations must be directly reachable again, and multi-location operations must keep cash, stock, and closeout records reliably separated by shop.

| Specialist | Owned area | Required change | Acceptance criterion |
|---|---|---|---|
| Configuration specialist | Onboarding, capability persistence, metric preference | Add explicit metric selection to setup and keep location capability state synchronized with the enforced optional-module setting. | An enabled location workflow no longer surfaces an off-state error; only selected metrics are persisted. |
| Finance operations specialist | Navigation and transaction surfaces | Restore direct access to Sales, Purchases, Payments, Receipts, Expenses, and Cash Book without depending on the floating action menu. | Each operation opens its existing working route from a stable Operations surface. |
| Inventory and location specialist | Shop scopes, stock, cash, and closeout | Keep product counts and transfers location-scoped; provide a single shop-close entry point that requires POS cash settlement and physical stock count review. | A shop can be closed only after a counted-cash closeout and reviewable physical stock count; consolidated reports remain available separately. |
| Interface specialist | Home and Reports information hierarchy | Remove workspace metrics and non-blocking backup reminders from Home; place selected metrics in Reports Summary with an obvious configuration path. | Home remains focused on financial position and operating totals; Reports shows only selected metrics. |
| Quality specialist | Tests and release checks | Add deterministic coverage for configuration mapping, metric selection, location module eligibility, and closeout requirements. | Tests, linting, type checks, and route-level regression checks pass before push. |

## Remediation decisions

The implementation uses **selected metric keys** rather than showing every metric implied by a capability. The selection is captured in onboarding and may be adjusted later in the workspace customization surface. Reports Summary owns metric display, while Home is intentionally limited to core financial health and daily operating totals.

For stores, **location scope is authoritative**. A cash movement, POS settlement, stock transfer, physical stock count, and individual shop closeout must name its location. Consolidated reporting remains an explicit All Shops view, not a substitute for closing an individual shop. Physical stock does not silently overwrite live stock; a counted stock record is stored with the shop, date, expected quantity, actual quantity, and variance before inventory adjustments can be finalized.
