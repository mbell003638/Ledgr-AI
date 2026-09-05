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
for (const party of parties) {
  for (const category of categories) {
    add(`did I record ${category} for ${party}`, []);
  }
}

if (rows.length > TARGET) {
  const negatives = rows.filter((row) => row.answers.length === 0);
  const rest = rows.filter((row) => row.answers.length > 0);
  const refuseKeep = Math.min(negatives.length, Math.floor(TARGET * 0.15));
  const callKeep = TARGET - refuseKeep;
  rows.length = 0;
  rows.push(...negatives.slice(0, refuseKeep), ...rest.slice(0, callKeep));
}

const out = path.join(root, 'needle-ledgr.jsonl');
fs.writeFileSync(out, rows.map((row) => JSON.stringify(row)).join('\n'));
const nCall = rows.filter((row) => row.answers.length).length;
console.log(`Wrote ${rows.length} local examples (${nCall} tool calls, ${rows.length - nCall} refusals) to ${out} (no cloud API).`);
