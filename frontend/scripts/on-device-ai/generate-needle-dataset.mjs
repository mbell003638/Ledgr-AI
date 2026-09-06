/**
 * Local Ledgr training JSONL for Needle. No OpenRouter, no paid models.
 * Target: ~10_000 unique { query, answers, tools } rows.
 *
 *   node ./scripts/on-device-ai/generate-needle-dataset.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const tools = JSON.parse(fs.readFileSync(path.join(root, 'ledgr-tools.json'), 'utf8'))
  .map((tool) => ({ name: tool.name }));

const TARGET = Number(process.env.NEEDLE_DATASET_SIZE || 10000);
const amounts = [5, 10, 12, 15, 20, 25, 35, 40, 50, 75, 80, 100, 120, 150, 200, 250, 300, 400, 500, 750, 1000, 1200, 2000, 2500, 5000, 8000, 15000];
const methods = ['cash', 'bank', 'card', 'mobile'];
const parties = ['Acme', 'Rahim', 'Amit', 'Sara', 'Ali', 'Omar', 'Fatima', 'Hassan', 'Noor', 'Yusuf', 'Fuel Station', 'City Mart'];
const categories = ['fuel', 'rent', 'utilities', 'meals', 'transport', 'supplies', 'wages', 'repairs'];
const dates = ['today', 'yesterday', '2026-08-01', '2026-09-03'];
const words = { 10: 'ten', 12: 'twelve', 20: 'twenty', 25: 'twenty five', 35: 'thirty five', 50: 'fifty', 80: 'eighty', 100: 'a hundred', 200: 'two hundred', 400: 'four hundred', 1200: 'twelve hundred', 5000: 'five thousand' };

const rows = [];
const seen = new Set();

function add(query, answers) {
  const q = String(query).replace(/\s+/g, ' ').trim();
  if (!q) return;
  const key = q.toLowerCase() + '|' + JSON.stringify(answers);
  if (seen.has(key)) return;
  seen.add(key);
  rows.push({ query: q, answers, tools });
}

function call(name, args) {
  return [{ name, arguments: args }];
}

function money(amount) {
  return [String(amount), `$${amount}`, `${amount} dollars`, words[amount]].filter(Boolean);
}

for (const amount of amounts) {
  for (const category of categories) {
    for (const method of methods) {
      add(`expense ${amount} ${category} ${method}`, call('add_expense', { amount, category, method }));
      add(`spent ${amount} on ${category} in ${method}`, call('add_expense', { amount, category, method }));
      add(`record ${category} expense ${amount} ${method}`, call('add_expense', { amount, category, method }));
      add(`pay ${amount} ${category} by ${method}`, call('add_expense', { amount, category, method }));
    }
    add(`record ${category} expense ${amount}`, call('add_expense', { amount, category }));
  }
  for (const phrase of money(amount)) {
    add(`expense ${phrase} fuel cash`, call('add_expense', { amount, category: 'fuel', method: 'cash' }));
    add(`spent ${phrase} on diesel in cash`, call('add_expense', { amount, category: 'fuel', method: 'cash' }));
  }
  add(`cash sale ${amount}`, call('add_sale', { amount, paymentType: 'cash' }));
  add(`sold ${amount} cash`, call('add_sale', { amount, paymentType: 'cash' }));
  add(`credit sale ${amount}`, call('add_sale', { amount, paymentType: 'credit' }));
  add(`sale ${amount}`, call('add_sale', { amount }));
  add(`stock count ${amount}`, call('record_inventory', { amount }));
  add(`inventory ${amount}`, call('record_inventory', { amount }));
  add(`closing stock ${amount}`, call('record_inventory', { amount }));
  add(`personal lunch ${amount} cash`, call('log_personal_expense', { amount, category: 'meals', method: 'cash' }));
  add(`personal expense ${amount} meals`, call('log_personal_expense', { amount, category: 'meals' }));
}

for (const party of parties) {
  for (const amount of amounts) {
    add(`bill from ${party} for ${amount}`, call('add_bill', { amount, supplierName: party }));
    add(`${party} billed us ${amount}`, call('add_bill', { amount, supplierName: party }));
    add(`purchase bill ${party} ${amount}`, call('add_bill', { amount, supplierName: party }));
    for (const method of methods) {
      add(`paid ${amount} to vendor ${party} by ${method}`, call('create_supplier_payment', { amount, supplierName: party, method }));
      add(`pay ${party} ${amount} ${method}`, call('create_supplier_payment', { amount, supplierName: party, method }));
    }
    add(`${party} deposited ${amount} capital`, call('add_capital', { amount, partnerName: party }));
    add(`add capital ${amount} for ${party}`, call('add_capital', { amount, partnerName: party }));
    add(`${party} invested ${amount}`, call('add_capital', { amount, partnerName: party }));
    add(`partner ${party} put in ${amount} capital`, call('add_capital', { amount, partnerName: party }));
    add(`withdraw ${amount} from ${party} capital`, call('create_drawing', { amount, partnerName: party }));
    add(`${party} withdrew ${amount}`, call('create_drawing', { amount, partnerName: party }));
    add(`drawing ${amount} ${party}`, call('create_drawing', { amount, partnerName: party }));
    add(`payout ${amount} to partner ${party}`, call('create_drawing', { amount, partnerName: party }));
    add(`received ${amount} from ${party} against the invoice`, call('create_receipt', { amount, customerName: party, mode: 'against_invoice' }));
    add(`received ${amount} from ${party}`, call('create_receipt', { amount, customerName: party, mode: 'against_invoice' }));
    add(`${party} paid ${amount}`, call('create_receipt', { amount, customerName: party, mode: 'against_invoice' }));
    add(`cash sale ${amount} from ${party}`, call('create_receipt', { amount, customerName: party, mode: 'cash_sale' }));
    add(`create invoice ${amount} for ${party}`, call('create_invoice', { amount, clientName: party }));
    add(`invoice ${party} ${amount}`, call('create_invoice', { amount, clientName: party }));
    add(`quote ${amount} for ${party}`, call('create_quote', { amount, clientName: party }));
  }
  add(`add customer ${party}`, call('add_debtor', { name: party }));
  add(`new customer ${party}`, call('add_debtor', { name: party }));
  add(`add supplier ${party}`, call('add_supplier', { name: party }));
  add(`new supplier ${party}`, call('add_supplier', { name: party }));
}

for (const date of dates) {
  const iso = date.includes('-') ? date : undefined;
  add(`expense 50 fuel cash ${date}`, call('add_expense', iso ? { amount: 50, category: 'fuel', method: 'cash', date: iso } : { amount: 50, category: 'fuel', method: 'cash' }));
  add(`Amit deposited 5000 capital ${date}`, call('add_capital', iso ? { amount: 5000, partnerName: 'Amit', date: iso } : { amount: 5000, partnerName: 'Amit' }));
}

const questions = [
  "what's my profit this month", 'how much cash do I have', 'show the balance sheet',
  'explain drawings', 'what is inventory', 'show trial balance', 'who owes me money',
  "what's my bank balance", 'open reports', 'how do I add a partner',
  'what is a capital account', 'show partner capital', 'open day book',
  'how do I record stock', 'what reports can I see',
];
for (const q of questions) add(q, []);
for (const party of parties) {
  add(`how much does ${party} owe`, []);
  add(`what did I pay ${party}`, []);
  add(`show ${party} balance`, []);
  add(`who is ${party}`, []);
  add(`delete customer ${party}`, []);
  add(`delete supplier ${party}`, []);
  add(`remove ${party} from customers`, []);
}
for (const category of categories) {
  add(`what is ${category}`, []);
  add(`explain ${category} expenses`, []);
  add(`how much did I spend on ${category}`, []);
}
for (const amount of amounts.slice(0, 12)) {
  add(`is ${amount} too much`, []);
  add(`don't record expense ${amount}`, []);
  add(`do not pay ${amount}`, []);
}
add('delete the inventory count', []);
add('remove the stock count from yesterday', []);
add('delete inventory_count', []);
add('erase yesterday stock count', []);
add("what's the weather", []);
add('play some music', []);
add('send an email', []);
add('turn on the lights', []);
add('set a timer', []);
add('call mom', []);
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
for (const party of parties) {
  for (const month of months) {
    add(`how much did I pay ${party} in ${month}`, []);
    add(`show ${party} activity for ${month}`, []);
  }
}
for (const category of categories) {
  for (const month of months) {
    add(`${category} total in ${month}`, []);
    add(`what did I spend on ${category} in ${month}`, []);
  }
}
const tails = ['please', 'now', 'for this shop', 'this year', 'quickly', 'in Ledgr'];
for (const q of questions) {
  for (const tail of tails) add(`${q} ${tail}`, []);
}
// ---- write tools that were declared but never trained ----------------------
// add_debtor_payment, update_entry and delete_entry have been in the tool list
// all along with zero examples behind them, so the model could never emit them.
for (const party of parties) {
  for (const amount of amounts.slice(0, 12)) {
    add(`${party} paid ${amount}`, call('add_debtor_payment', { name: party, amount }));
    add(`received ${amount} from ${party}`, call('add_debtor_payment', { name: party, amount }));
    for (const method of methods) {
      add(`${party} paid ${amount} by ${method}`, call('add_debtor_payment', { name: party, amount, method }));
    }
  }
}
const entities = ['expense', 'sale', 'bill', 'invoice', 'receipt', 'supplier_payment'];
for (const entity of entities) {
  for (const amount of amounts.slice(0, 10)) {
    add(`change that ${entity} to ${amount}`, call('update_entry', { entity, changes: { amount } }));
    add(`correct the ${entity} amount to ${amount}`, call('update_entry', { entity, changes: { amount } }));
    add(`edit last ${entity} amount ${amount}`, call('update_entry', { entity, changes: { amount } }));
  }
  add(`delete that ${entity}`, call('delete_entry', { entity }));
  add(`remove the last ${entity}`, call('delete_entry', { entity }));
  add(`cancel that ${entity}`, call('delete_entry', { entity }));
}

// ---- workflow tools (marketplace, projects, creator, manufacturing, trade) --
// These 15 were declared in ASSISTANT_PROPOSAL_TYPES and validated by
// validateAssistantProposal, but were never in the on-device tool list, so the
// model had no way to reach any of them.
const platforms = ['amazon', 'flipkart', 'shopify', 'etsy', 'meesho'];
const brands = ['Nova', 'Zephyr', 'Lumen', 'Orbit'];
const kinds = ['freight', 'duty', 'insurance', 'handling'];
for (const platform of platforms) {
  for (const amount of amounts.slice(0, 10)) {
    const id = `${platform.slice(0, 2).toUpperCase()}${amount}`;
    add(`${platform} order ${id} for ${amount}`, call('create_marketplace_order', { platform, externalOrderId: id, gross: amount }));
    add(`new ${platform} sale ${id} ${amount}`, call('create_marketplace_order', { platform, externalOrderId: id, gross: amount }));
    add(`refund ${amount} on order ${id}`, call('record_marketplace_refund', { orderId: id, amount }));
    add(`customer returned order ${id} fee ${amount}`, call('record_marketplace_rto', { orderId: id, fee: amount }));
    add(`${platform} payout ${amount} settlement S${amount}`, call('create_marketplace_settlement', { platform, settlementId: `S${amount}`, payout: amount }));
  }
}
for (const party of parties) {
  for (const amount of amounts.slice(0, 8)) {
    add(`start project ${party} budget ${amount}`, call('create_project', { name: party, budget: amount }));
    add(`new project ${party}`, call('create_project', { name: party }));
    add(`log ${amount} hours on project ${party}`, call('add_project_time', { projectId: party, hours: amount }));
    add(`project ${party} cost ${amount}`, call('record_project_cost', { projectId: party, amount }));
  }
}
for (const brand of brands) {
  for (const amount of amounts.slice(0, 8)) {
    add(`contract with ${brand} campaign summer for ${amount}`, call('create_creator_contract', { brand, campaign: 'summer', agreedAmount: amount }));
    add(`${brand} deal ${amount}`, call('create_creator_contract', { brand, campaign: 'general', agreedAmount: amount }));
    add(`payout ${amount} on contract ${brand}`, call('record_creator_payout', { contractId: brand, amount }));
  }
}
for (const amount of amounts.slice(0, 10)) {
  add(`create bom for product P${amount} called kit`, call('create_bom', { productId: `P${amount}`, name: 'kit' }));
  add(`add component C${amount} quantity ${amount} to bom B1`, call('add_bom_line', { bomId: 'B1', componentProductId: `C${amount}`, quantity: amount }));
  add(`produce ${amount} from bom B1`, call('create_production_order', { bomId: 'B1', quantity: amount }));
  add(`production order B1 quantity ${amount}`, call('create_production_order', { bomId: 'B1', quantity: amount }));
  add(`import shipment REF${amount} worth ${amount}`, call('create_trade_shipment', { reference: `REF${amount}`, direction: 'import', goodsValue: amount }));
  add(`export shipment REF${amount}`, call('create_trade_shipment', { reference: `REF${amount}`, direction: 'export' }));
  for (const kind of kinds) {
    add(`${kind} ${amount} on shipment REF${amount}`, call('add_trade_landed_cost', { shipmentId: `REF${amount}`, kind, amount }));
  }
  add(`fx gain ${amount}`, call('record_fx_remeasurement', { gainLoss: 'gain', amount }));
  add(`fx loss ${amount}`, call('record_fx_remeasurement', { gainLoss: 'loss', amount }));
  add(`exchange rate loss of ${amount}`, call('record_fx_remeasurement', { gainLoss: 'loss', amount }));
}

// ---- read tools -------------------------------------------------------------
// The write tools above record things; these let the model answer a question
// instead of only acting. Without them "how much does Amit owe" has no tool to
// reach for and the assistant looks like it does not know the app.
const reports = [
  ['profit and loss', 'profit_and_loss'], ['p and l', 'profit_and_loss'], ['profit', 'profit_and_loss'],
  ['balance sheet', 'balance_sheet'], ['cash flow', 'cash_flow'], ['trial balance', 'trial_balance'],
];
const ranges = [
  ['this month', 'month'], ['last month', 'last_month'], ['this year', 'year'], ['today', 'today'],
];
for (const [spoken, report] of reports) {
  for (const [phrase, range] of ranges) {
    add(`show ${spoken} ${phrase}`, call('report_query', { report, from: range, to: range }));
    add(`what is my ${spoken} ${phrase}`, call('report_query', { report, from: range, to: range }));
    add(`${spoken} report ${phrase}`, call('report_query', { report, from: range, to: range }));
  }
  add(`show ${spoken}`, call('report_query', { report }));
}
for (const party of parties) {
  add(`how much does ${party} owe`, call('party_lookup', { query: party, role: 'customer' }));
  add(`how much do we owe ${party}`, call('party_lookup', { query: party, role: 'supplier' }));
  add(`balance for ${party}`, call('party_lookup', { query: party }));
  add(`find ${party}`, call('party_lookup', { query: party }));
  add(`${party} account`, call('party_lookup', { query: party }));
  add(`show me ${party} ledger`, call('party_lookup', { query: party }));
}
for (const [phrase, range] of ranges) {
  add(`stock profit ${phrase}`, call('inventory_profit', { from: range, to: range }));
  add(`inventory profit ${phrase}`, call('inventory_profit', { from: range, to: range }));
  add(`gross margin ${phrase}`, call('inventory_profit', { from: range, to: range }));
}
for (const phrase of [
  'what can you do', 'what can this app do', 'what do you know about this app',
  'help', 'what features are on', 'which workflows are enabled', 'what is ledgr',
]) {
  add(phrase, call('describe_capabilities', {}));
}

for (const party of parties) {
  for (const category of categories) {
    add(`did I record ${category} for ${party}`, []);
  }
}

// ---- refusals ---------------------------------------------------------------
// Teaching the model when NOT to call a tool matters as much as when to. Too
// few negatives and it fires on greetings, questions and half-finished thoughts.
for (const phrase of [
  'hi', 'hello', 'hey there', 'good morning', 'thanks', 'thank you', 'ok', 'never mind',
  'how are you', 'are you there', 'testing', 'what', 'huh', 'sorry',
  'i paid', 'paid', 'add', 'record', 'create', 'delete', 'update it', 'change it',
  'paid to', 'sold to', 'bill from', 'expense of', 'amount', 'yesterday', 'today',
  'is that right', 'did it save', 'is it done', 'show me', 'open it', 'go back',
  'what should i do', 'i am not sure', 'maybe later', 'call my accountant',
  'what is the weather', 'tell me a joke', 'who won the match', 'set an alarm',
  'send a whatsapp', 'call amit', 'email the invoice to someone',
]) {
  add(phrase, []);
  for (const lead of ['please ', 'can you ', 'hey ']) add(lead + phrase, []);
}
for (const party of parties) {
  add(`about ${party}`, []);
  add(`${party}`, []);
  add(`something for ${party}`, []);
  add(`did ${party} pay`, []);
}
for (const amount of amounts) {
  add(`${amount}`, []);
  add(`about ${amount}`, []);
  add(`maybe ${amount} or so`, []);
}

// ---- phrasing augmentation --------------------------------------------------
// Real users do not speak in clean commands. They say "please", "can you",
// "hey", they trail off, and they answer a question with the request restated.
// Training only on terse forms is why "Yes create amit account and paid 100$"
// missed. Every generated row gets natural variants of the same call.
const LEAD_INS = ['please ', 'can you ', 'could you ', 'hey ', 'ok ', 'yes ', 'i want to ', 'i need to ', 'help me '];
const TAIL_ONS = [' please', ' thanks', ' today', ' now', ' for me'];

{
  const base = rows.slice();
  for (const row of base) {
    // Negatives are augmented too: "please" in front of a half-finished thought
    // is still a half-finished thought, and skipping them left refusals at ~1%
    // of the set, which teaches the model to fire on almost anything.
    for (const lead of LEAD_INS) add(lead + row.query, row.answers);
    for (const tail of TAIL_ONS) add(row.query + tail, row.answers);
    add(row.query.charAt(0).toUpperCase() + row.query.slice(1), row.answers);
    add(row.query.replace(/(\d+)/, '$$$1'), row.answers);
  }
  // More ways to ask what the app is, so the answer never falls through to the
  // generic "returned nothing usable".
  for (const phrase of [
    'what can you do', 'what can this app do', 'what do you know about this app',
    'what is ledgr', 'what does ledgr do', 'who are you', 'what are you',
    'tell me about this app', 'what features do i have', 'what is enabled',
    'which workflows are on', 'what can i ask you', 'how can you help',
    'what are your abilities', 'list your tools', 'what do you support',
    'capabilities', 'features', 'help', 'help me understand this app',
  ]) {
    add(phrase, call('describe_capabilities', {}));
    for (const lead of LEAD_INS) add(lead + phrase, call('describe_capabilities', {}));
  }
}

// push(...array) passes every element as an argument, which overflows the call
// stack once the dataset reaches six figures. Append in place instead.
function pushAll(target, source) {
  for (let i = 0; i < source.length; i += 1) target.push(source[i]);
  return target;
}

if (rows.length > TARGET) {
  // Trim stratified by tool, not by insertion order. Slicing the first N rows
  // silently dropped every example for tools generated last -- the read tools
  // ended up with zero rows in a 10k dataset, so the model could never learn
  // to call them however the runtime declared them.
  const negatives = rows.filter((row) => row.answers.length === 0);
  const refuseKeep = Math.min(negatives.length, Math.floor(TARGET * 0.15));
  const callKeep = TARGET - refuseKeep;

  const byTool = new Map();
  for (const row of rows) {
    if (!row.answers.length) continue;
    const name = row.answers[0].name;
    if (!byTool.has(name)) byTool.set(name, []);
    byTool.get(name).push(row);
  }

  const kept = [];
  const buckets = [...byTool.values()];
  const perTool = Math.max(1, Math.floor(callKeep / Math.max(1, buckets.length)));
  for (const bucket of buckets) pushAll(kept, bucket.slice(0, perTool));
  // Fill any remaining budget round-robin so common tools stay well covered.
  let cursor = perTool;
  while (kept.length < callKeep) {
    let added = false;
    for (const bucket of buckets) {
      if (cursor < bucket.length && kept.length < callKeep) { kept.push(bucket[cursor]); added = true; }
    }
    if (!added) break;
    cursor += 1;
  }

  rows.length = 0;
  pushAll(rows, negatives.slice(0, refuseKeep));
  pushAll(rows, kept);
}

const out = path.join(root, 'needle-ledgr.jsonl');
fs.writeFileSync(out, rows.map((row) => JSON.stringify(row)).join('\n'));
const nCall = rows.filter((row) => row.answers.length).length;
console.log(`Wrote ${rows.length} local examples (${nCall} tool calls, ${rows.length - nCall} refusals) to ${out} (no cloud API).`);
