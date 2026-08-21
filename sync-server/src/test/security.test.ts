import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizationError, BookMembershipAuthorizer, type SyncPrincipal } from "../auth.js";
import { accountingSnapshot, ArbitrationError, DefaultAccountingArbitrator, StaticAccountingDomainStateReader } from "../arbitration.js";
import { hashPayload, type SyncOperation } from "../protocol.js";
import { PostgresBookAuthorizer } from "../postgres.js";

const principal: SyncPrincipal = { subject: "user-1", scopes: new Set(), books: new Set(["book-1"]), claims: {} };
const operation = (payload: unknown, commandType = "note.create"): SyncOperation => ({ protocolVersion: 1, payloadVersion: 1, opId: "op-1", bookId: "book-1", bookEpoch: "epoch-1", deviceId: "device-1", deviceSequence: 1, actorId: "user-1", commandType, aggregateId: "aggregate-1", payload, payloadHash: hashPayload(payload), clientCreatedAt: "2026-08-20T00:00:00.000Z" });

test("book membership authorizer denies unlisted books", () => {
  assert.throws(() => new BookMembershipAuthorizer().authorize(principal, "book-2", "pull"), AuthorizationError);
});

test("accounting arbitrator rejects unbalanced journals", async () => {
  await assert.rejects(() => new DefaultAccountingArbitrator().validate({ bookId: "book-1", principal, operations: [operation({ lines: [{ debit: 10 }, { credit: 9 }] }, "journal.post")] }), ArbitrationError);
});

test("accounting arbitrator accepts balanced journals", async () => {
  await new DefaultAccountingArbitrator().validate({ bookId: "book-1", principal, operations: [operation({ lines: [{ debit: 10 }, { credit: 10 }] }, "journal.post")] });
});

test("accounting arbitrator rejects an actor different from the authenticated principal", async () => {
  await assert.rejects(() => new DefaultAccountingArbitrator().validate({
    bookId: "book-1", principal, operations: [{ ...operation({ lines: [{ debit: 10 }, { credit: 10 }] }, "journal.post"), actorId: "other-user" }],
  }), /actor does not match/);
});

test("accounting arbitrator requires period-close revision and validates inventory counts", async () => {
  await assert.rejects(() => new DefaultAccountingArbitrator().validate({ bookId: "book-1", principal, operations: [operation({ date: "2026-08-20" }, "period.close")] }), /requires a baseRevision/);
  await assert.rejects(() => new DefaultAccountingArbitrator().validate({ bookId: "book-1", principal, operations: [{ ...operation({ date: "2026-08-20", value: -1 }, "inventory.count.record"), baseRevision: 0 }] }), /non-negative/);
  await new DefaultAccountingArbitrator().validate({ bookId: "book-1", principal, operations: [{ ...operation({ date: "2026-08-20", value: 10 }, "inventory.count.record"), baseRevision: 0 }] });
});

test("accounting arbitrator validates allocation and location-transfer references", async () => {
  await assert.rejects(() => new DefaultAccountingArbitrator().validate({ bookId: "book-1", principal, operations: [{ ...operation({ amount: 5 }, "receipt.allocate"), baseRevision: 0 }] }), /requires invoiceSourceId/);
  await assert.rejects(() => new DefaultAccountingArbitrator().validate({ bookId: "book-1", principal, operations: [operation({ fromLocationId: "a", toLocationId: "a", qty: 1 }, "location.transfer_stock")] }), /distinct/);
  await new DefaultAccountingArbitrator().validate({ bookId: "book-1", principal, operations: [{ ...operation({ invoiceSourceId: "invoice-1", receiptSourceId: "receipt-1", amount: 5 }, "receipt.allocate"), baseRevision: 0 }] });
});

test("stateful arbitrator serializes allocations against invoice and receipt balances", async () => {
  const state = accountingSnapshot({
    bookSequence: 7,
    invoices: new Map([["invoice-1", { sourceId: "invoice-1", partyId: "customer-1", total: 100, allocated: 60 }]]),
    receipts: new Map([["receipt-1", { sourceId: "receipt-1", partyId: "customer-1", total: 50, allocated: 0 }]]),
  });
  const arbitrator = new DefaultAccountingArbitrator(new StaticAccountingDomainStateReader(state), { requireState: true });
  const first = { ...operation({ invoiceSourceId: "invoice-1", receiptSourceId: "receipt-1", amount: 25 }, "receipt.allocate"), opId: "alloc-1", baseRevision: 0 };
  const second = { ...operation({ invoiceSourceId: "invoice-1", receiptSourceId: "receipt-1", amount: 20 }, "receipt.allocate"), opId: "alloc-2", deviceSequence: 2, baseRevision: 0 };
  await assert.rejects(() => arbitrator.validate({ bookId: "book-1", principal, operations: [first, second] }), (error: unknown) => error instanceof ArbitrationError && error.code === "ALLOCATION_EXCEEDS_INVOICE");
});

test("stateful arbitrator enforces stock, location cash, capital ownership, and reversal uniqueness", async () => {
  const state = accountingSnapshot({
    bookSequence: 8,
    products: new Map([["product-1", { productId: "product-1", active: true }]]),
    locations: new Map([
      ["north", { locationId: "north", active: true }],
      ["south", { locationId: "south", active: true }],
    ]),
    capitalMembers: new Map([["member-1", { memberId: "member-1", active: true, ownerActorIds: new Set(["owner-2"]) }]]),
    stockByProductLocation: new Map([["product-1\u0000north", 2]]),
    cashByLocationMethod: new Map([["north\u0000cash", 10]]),
    reversedOriginalIds: new Set(["source-reversed"]),
  });
  const arbitrator = new DefaultAccountingArbitrator(new StaticAccountingDomainStateReader(state), { requireState: true });
  await assert.rejects(() => arbitrator.validate({ bookId: "book-1", principal, operations: [operation({ productId: "product-1", fromLocationId: "north", toLocationId: "south", qty: 3 }, "location.transfer_stock")] }), (error: unknown) => error instanceof ArbitrationError && error.code === "INSUFFICIENT_STOCK");
  await assert.rejects(() => arbitrator.validate({ bookId: "book-1", principal, operations: [operation({ fromLocationId: "north", toLocationId: "south", amount: 11 }, "location.transfer_cash")] }), (error: unknown) => error instanceof ArbitrationError && error.code === "INSUFFICIENT_LOCATION_BALANCE");
  await assert.rejects(() => arbitrator.validate({ bookId: "book-1", principal, operations: [operation({ memberId: "member-1", input: { amount: 5, date: "2026-08-20" } }, "capital.deposit")] }), (error: unknown) => error instanceof ArbitrationError && error.code === "CAPITAL_OWNERSHIP_REQUIRED");
  await assert.rejects(() => arbitrator.validate({ bookId: "book-1", principal, operations: [{ ...operation({ sourceId: "source-reversed" }, "transaction.reverse"), baseRevision: 0 }] }), (error: unknown) => error instanceof ArbitrationError && error.code === "DUPLICATE_REVERSAL");
});

test("period close requires authority and the exact canonical sequence barrier", async () => {
  const authorized = { ...principal, scopes: new Set(["accounting:period-close"]) };
  const state = accountingSnapshot({ bookSequence: 12 });
  const arbitrator = new DefaultAccountingArbitrator(new StaticAccountingDomainStateReader(state), { requireState: true });
  await assert.rejects(() => arbitrator.validate({ bookId: "book-1", principal: authorized, operations: [{ ...operation({ date: "2026-08-20", expectedBookSequence: 11 }, "period.close"), baseRevision: 0 }] }), (error: unknown) => error instanceof ArbitrationError && error.code === "PERIOD_BARRIER_STALE");
  await arbitrator.validate({ bookId: "book-1", principal: authorized, operations: [{ ...operation({ date: "2026-08-20", expectedBookSequence: 12 }, "period.close"), baseRevision: 0 }] });
});

test("audited corrections require lineage and prohibit historical overwrite", async () => {
  const correcting = { ...principal, scopes: new Set(["accounting:correct"]) };
  const state = accountingSnapshot({ bookSequence: 3, openConflictIds: new Set(["conflict-1"]), accountIds: new Set(["cash", "sales"]), authority: { mayCorrect: true, mayClosePeriod: false, mayManageOpeningBalances: false, mayPostAnyCapital: false } });
  const arbitrator = new DefaultAccountingArbitrator(new StaticAccountingDomainStateReader(state), { requireState: true });
  const posting = { date: "2026-08-20", lines: [{ accountId: "cash", debit: 10 }, { accountId: "sales", credit: 10 }] };
  await assert.rejects(() => arbitrator.validate({ bookId: "book-1", principal: correcting, operations: [{ ...operation({ reason: "Fix", posting }, "accounting.correction.post"), baseRevision: 0 }] }), /audit link/);
  await assert.rejects(() => arbitrator.validate({ bookId: "book-1", principal: correcting, operations: [{ ...operation({ reason: "Fix", conflictId: "conflict-1", overwrite: true, posting }, "accounting.correction.post"), baseRevision: 0 }] }), /cannot be overwritten/);
  await arbitrator.validate({ bookId: "book-1", principal: correcting, operations: [{ ...operation({ reason: "Fix classification", conflictId: "conflict-1", posting }, "accounting.correction.post"), baseRevision: 0 }] });
});

test("stateful mark-paid arbitration rejects a second concurrent settlement", async () => {
  const state = accountingSnapshot({
    bookSequence: 20,
    invoices: new Map([["invoice-1", { sourceId: "invoice-1", partyId: "customer-1", total: 100, allocated: 60 }]]),
  });
  const arbitrator = new DefaultAccountingArbitrator(new StaticAccountingDomainStateReader(state), { requireState: true });
  const payload = (receiptId: string) => ({
    name: "markInvoicePaid",
    args: ["invoice-1", { date: "2026-08-20", method: "cash" }],
    _result: { source: { id: receiptId, metadata: { total: 40, partyId: "customer-1" } } },
  });
  const first = { ...operation(payload("pay-1"), "transaction.mutate"), opId: "pay-1", baseRevision: 0 };
  const second = { ...operation(payload("pay-2"), "transaction.mutate"), opId: "pay-2", deviceSequence: 2, baseRevision: 0 };
  await assert.rejects(
    () => arbitrator.validate({ bookId: "book-1", principal, operations: [first, second] }),
    (error: unknown) => error instanceof ArbitrationError && error.code === "ALLOCATION_EXCEEDS_INVOICE",
  );
});

test("invoice creation must capture every canonical oldest-first customer advance", async () => {
  const state = accountingSnapshot({
    bookSequence: 20,
    receipts: new Map([
      ["advance-old", { sourceId: "advance-old", partyId: "customer-1", date: "2026-08-01", total: 30, allocated: 0 }],
      ["advance-new", { sourceId: "advance-new", partyId: "customer-1", date: "2026-08-02", total: 50, allocated: 0 }],
    ]),
  });
  const arbitrator = new DefaultAccountingArbitrator(new StaticAccountingDomainStateReader(state), { requireState: true });
  const base = { name: "createInvoice", input: { partyId: "customer-1", date: "2026-08-20", amount: 60 }, _result: { source: { id: "op-1" }, allocations: [] } };
  await assert.rejects(
    () => arbitrator.validate({ bookId: "book-1", principal, operations: [operation(base, "transaction.create")] }),
    (error: unknown) => error instanceof ArbitrationError && error.code === "ALLOCATION_LINEAGE_MISMATCH",
  );
  const complete = { ...base, _result: { source: { id: "op-1" }, allocations: [
    { invoiceSourceId: "op-1", receiptSourceId: "advance-old", amount: 30 },
    { invoiceSourceId: "op-1", receiptSourceId: "advance-new", amount: 30 },
  ] } };
  await arbitrator.validate({ bookId: "book-1", principal, operations: [operation(complete, "transaction.create")] });
});

test("invoice replacement releases prior automatic advances before canonical reallocation", async () => {
  const state = accountingSnapshot({
    bookSequence: 21,
    invoices: new Map([["invoice-old", { sourceId: "invoice-old", partyId: "customer-1", total: 40, allocated: 40 }]]),
    receipts: new Map([["advance-1", { sourceId: "advance-1", partyId: "customer-1", date: "2026-08-01", total: 100, allocated: 40, allocationByInvoice: new Map([["invoice-old", 40]]), advanceAllocationByInvoice: new Map([["invoice-old", 40]]) }]]),
  });
  const arbitrator = new DefaultAccountingArbitrator(new StaticAccountingDomainStateReader(state), { requireState: true });
  const payload = {
    name: "updateInvoice",
    args: ["invoice-old", { partyId: "customer-1", date: "2026-08-20", amount: 80 }],
    _result: { source: { id: "replacement_op-1" }, allocations: [{ invoiceSourceId: "replacement_op-1", receiptSourceId: "advance-1", amount: 80 }] },
  };
  await arbitrator.validate({ bookId: "book-1", principal, operations: [{ ...operation(payload, "transaction.mutate"), aggregateId: "invoice-old", baseRevision: 1 }] });
});

test("transaction replacements require the exact reserved operation-derived source id", async () => {
  const state = accountingSnapshot({ bookSequence: 22 });
  const arbitrator = new DefaultAccountingArbitrator(new StaticAccountingDomainStateReader(state), { requireState: true });
  const payload = { name: "updateExpense", args: ["expense-old", { date: "2026-08-20", amount: 10, method: "cash" }], _result: { source: { id: "expense_op-1_9" } } };
  await assert.rejects(
    () => arbitrator.validate({ bookId: "book-1", principal, operations: [{ ...operation(payload, "transaction.mutate"), aggregateId: "expense-old", baseRevision: 1 }] }),
    /exact operation-derived id/,
  );
});

test("stateful arbitration rejects forged accounting result identities", async () => {
  const state = accountingSnapshot({
    bookSequence: 21,
    invoices: new Map([["invoice-1", { sourceId: "invoice-1", partyId: "customer-1", total: 40, allocated: 0 }]]),
  });
  const arbitrator = new DefaultAccountingArbitrator(new StaticAccountingDomainStateReader(state), { requireState: true });
  const payload = {
    name: "markInvoicePaid",
    args: ["invoice-1", { date: "2026-08-20", method: "cash" }],
    _result: { source: { id: "attacker-controlled", metadata: { total: 40, partyId: "customer-1" } } },
  };
  await assert.rejects(
    () => arbitrator.validate({ bookId: "book-1", principal, operations: [{ ...operation(payload, "transaction.mutate"), opId: "pay-safe", baseRevision: 0 }] }),
    /non-deterministic source id/,
  );
});

test("audited corrections reject accounts outside the canonical book", async () => {
  const correcting = { ...principal, scopes: new Set(["accounting:correct"]) };
  const state = accountingSnapshot({
    bookSequence: 22,
    openConflictIds: new Set(["conflict-1"]),
    accountIds: new Set(["cash"]),
    authority: { mayCorrect: true, mayClosePeriod: false, mayManageOpeningBalances: false, mayPostAnyCapital: false },
  });
  const arbitrator = new DefaultAccountingArbitrator(new StaticAccountingDomainStateReader(state), { requireState: true });
  const payload = {
    reason: "Correct classification",
    conflictId: "conflict-1",
    posting: { date: "2026-08-20", lines: [{ accountId: "cash", debit: 10 }, { accountId: "foreign-account", credit: 10 }] },
  };
  await assert.rejects(
    () => arbitrator.validate({ bookId: "book-1", principal: correcting, operations: [{ ...operation(payload, "accounting.correction.post"), baseRevision: 0 }] }),
    (error: unknown) => error instanceof ArbitrationError && error.code === "STATE_REFERENCE_MISSING",
  );
});

test("all state-changing update and delete commands require aggregate revisions", async () => {
  const arbitrator = new DefaultAccountingArbitrator();
  for (const commandType of ["cash.patch", "cash.delete", "employee.upsert", "employee.archive", "inventory.count.delete"]) {
    await assert.rejects(
      () => arbitrator.validate({ bookId: "book-1", principal, operations: [operation({}, commandType)] }),
      /requires a baseRevision/,
    );
  }
});

test("closed periods reject undated deletion of a historical source", async () => {
  const state = accountingSnapshot({ bookSequence: 23, closedThrough: "2026-07-31", sourceDates: new Map([["invoice-closed", "2026-07-15"]]) });
  const arbitrator = new DefaultAccountingArbitrator(new StaticAccountingDomainStateReader(state), { requireState: true });
  const payload = { name: "deleteInvoice", args: ["invoice-closed"] };
  await assert.rejects(
    () => arbitrator.validate({ bookId: "book-1", principal, operations: [{ ...operation(payload, "transaction.mutate"), aggregateId: "invoice-closed", baseRevision: 1 }] }),
    (error: unknown) => error instanceof ArbitrationError && error.code === "PERIOD_CLOSED",
  );
});

test("PostgreSQL authorizer rejects a revoked device", async () => {
  const pool = {
    query: async (sql: string) => sql.includes("FROM sync_devices d")
      ? { rows: [{ subject: "user-1", revoked_at: "2026-08-20T00:00:00.000Z", expires_at: "2099-08-20T00:00:00.000Z", enrolled_epoch: "epoch-1", book_epoch: "epoch-1" }] }
      : { rows: [] },
  } as any;
  await assert.rejects(() => new PostgresBookAuthorizer(pool).authorize(principal, "book-1", "pull", "device-1"), /revoked/);
});

test("PostgreSQL authorizer rejects an expired device enrollment", async () => {
  const pool = {
    query: async (sql: string) => sql.includes("FROM sync_devices d")
      ? { rows: [{ subject: "user-1", revoked_at: null, expires_at: "2020-01-01T00:00:00.000Z", enrolled_epoch: "epoch-1", book_epoch: "epoch-1" }] }
      : { rows: [] },
  } as any;
  await assert.rejects(() => new PostgresBookAuthorizer(pool).authorize(principal, "book-1", "pull", "device-1"), /expired/);
});

test("PostgreSQL authorizer requires explicit enrollment and records last seen", async () => {
  const pullPrincipal = { ...principal, scopes: new Set(["sync:pull"]) };
  const calls: string[] = [];
  const unknownPool = {
    query: async (sql: string) => { calls.push(sql); return { rows: [] }; },
  } as any;
  await assert.rejects(() => new PostgresBookAuthorizer(unknownPool).authorize(pullPrincipal, "book-1", "pull", "unknown-device"), /not enrolled/);
  assert.equal(calls.some((sql) => sql.includes("INSERT INTO sync_devices")), false);

  const enrolledCalls: string[] = [];
  const enrolledPool = {
    query: async (sql: string) => {
      enrolledCalls.push(sql);
      if (sql.includes("FROM sync_devices d")) return { rows: [{ subject: "user-1", revoked_at: null, expires_at: "2099-08-20T00:00:00.000Z", enrolled_epoch: "epoch-1", book_epoch: "epoch-1" }] };
      return { rows: [] };
    },
  } as any;
  const pushPrincipal = { ...principal, scopes: new Set(["sync:push"]) };
  await new PostgresBookAuthorizer(enrolledPool).authorize(pushPrincipal, "book-1", "push", "device-1");
  assert.equal(enrolledCalls.some((sql) => sql.includes("SET last_seen_at=now()")), true);
});
