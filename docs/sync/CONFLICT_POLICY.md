# Sync conflict policy

Ledgr does not use blanket last-write-wins for accounting. Operations are
validated against the canonical book revision and handled according to their
business meaning. Every conflict is retained with base, local and canonical
references; resolution is itself an audited operation.

## Terms

- **Independent**: operations affect different aggregates or disjoint fields
  and can both be applied without changing accounting meaning.
- **Canonical**: the server-accepted event sequence for a book epoch.
- **Correction**: a new posting or reversal that preserves the audit trail;
  historical journal lines are never edited in place.
- **Needs review**: local intent is preserved but cannot be automatically made
  canonical without an explicit user decision.

## Operation matrix

| Concurrent operations | Default result | Rationale/action |
| --- | --- | --- |
| Two independent sales, invoices, bills, expenses, payments or capital entries | Accept both | They are separate append-only accounting events. |
| Same source edited on two devices | Canonical + conflict | Keep both payloads; offer keep canonical or post my version as a new correction. |
| Edit versus archive/delete | Conflict | Preserve the edit and tombstone intent; user chooses the audited outcome. |
| Two reversals of one source/journal | One reversal + duplicate conflict | The unique reversal invariant allows exactly one; second intent is retained as already reversed. |
| Customer/Supplier phone changed on one device and email on another | Auto-merge | Disjoint field patches commute. |
| Same party field changed differently | Conflict | Do not silently choose a name, phone or email. |
| Roles added/removed | Set operation | Use per-role add/remove commands; do not replace the whole roles JSON. |
| Invoice and receipt allocation | Serialize and validate | Canonical allocation cannot exceed invoice open amount; over-allocation becomes conflict. |
| Two receipts allocating the same remaining invoice amount | Serialize | First accepted allocation wins that amount; remainder is reviewable, never silently dropped. |
| Product master fields changed independently | Auto-merge | Merge disjoint fields; same-field differences need review. |
| Concurrent stock moves | Accept all, recompute | Stock is derived from moves. Negative global stock is an explicit exception, not data loss. |
| Two inventory counts for same product/location/date | Conflict | Never average or overwrite counts; choose one and post an adjustment if needed. |
| Location transfer versus sale | Accept valid events | Validate source/destination and derive each location's quantity. |
| Opening balances or capital configuration changed concurrently | Conflict | Amounts and ownership shares require explicit review. |
| Feature enable | Auto-merge | Enabling is generally commutative. |
| Feature disable | Revalidate canonical state | Run data blockers after all preceding events; reject or conflict if dependent activity exists. |
| Period close versus unseen offline posting | Server barrier + late entry | Close one canonical cutoff. Preserve late posting and require current-period correction/annotation. |
| Restore/reset/delete book | Owner epoch advance | Old epoch operations cannot reappear; devices must re-enroll. |

## Inventory policy

Disconnected devices cannot know each other's stock. The default accounting
policy accepts genuine offline movements and displays a negative-stock
exception for correction. A strict-stock deployment may allocate online quotas
to devices/locations; a device then refuses offline sales beyond its quota, at
the cost of potentially blocking a sale that another device could have covered.
The product must state which policy is active.

## User resolution flow

The conflict inbox shows the aggregate, business date, actor/device and a
three-way view: base revision, this device's operation and canonical version.
Users can:

1. Keep canonical and mark local intent resolved.
2. Apply local intent as a new correction (for accounting, a new source/journal
   or a reversal-and-replacement through the existing V2 document service).
3. Enter an explicit combined value where the policy permits field merging.

Resolving a conflict never deletes either original operation. A rejected or
superseded operation remains queryable in the audit history.

## Period-close barrier

Period close is a global operation, not an ordinary row edit. The server locks
the book/period, chooses a cutoff `bookSequence`, freezes the close snapshot,
and returns one idempotent result. A posting first created offline inside the
closed date range remains visible with its original business date, but its
canonical correction is posted in the current open period and labeled as a
late entry. Closing cannot silently ignore an unseen device.

## Invariants after every resolution

- Every accepted journal is balanced and belongs to one book and period.
- Reversal lineage is one-to-one and historical entries remain immutable.
- Receipt allocations never exceed the canonical invoice amount.
- Trial balance, balance sheet, capital and stock projections reconcile.
- Tombstones prevent an archived/deleted identity from being recreated by a
  delayed operation.
- All devices converge to the same canonical cursor and checkpoint hash.
