/**
 * Local Ledgr training JSONL for Needle. No OpenRouter, no paid models.
 * Format matches cactus-needle finetune.py: { query, answers, tools, reasoning }
 *
 *   node ./scripts/on-device-ai/generate-needle-dataset.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const tools = JSON.parse(fs.readFileSync(path.join(root, 'ledgr-tools.json'), 'utf8'));

const amounts = [12, 20, 35, 50, 80, 100, 150, 200, 400, 750, 1200, 2500, 5000, 15000];
const methods = ['cash', 'bank', 'card', 'mobile'];
const parties = ['Acme', 'Rahim', 'Amit', 'Sara', 'Fuel Station', 'Ali', 'Omar'];
const categories = ['fuel', 'rent', 'utilities', 'meals', 'transport', 'supplies'];

const rows = [];
const seen = new Set();

function add(query, answers, reasoning) {
  const key = query.trim().toLowerCase() + '|' + JSON.stringify(answers);
  if (seen.has(key)) return;
  seen.add(key);
  rows.push({
    query,
    reasoning: reasoning || '',
    answers,
    tools,
  });
}

function call(name, args) {
  return [{ name, arguments: args }];
}

for (const amount of amounts) {
  for (const category of categories.slice(0, 4)) {
    add(`expense ${amount} ${category} cash`, call('add_expense', { amount, category, method: 'cash' }), `${amount} is the amount; ${category} is the category; cash is the method`);
    add(`spent ${amount} on ${category} in cash`, call('add_expense', { amount, category, method: 'cash' }), `spent ${amount} on ${category} cash`);
    add(`record ${category} expense ${amount}`, call('add_expense', { amount, category }), `${category} expense of ${amount}`);
  }
  add(`cash sale ${amount}`, call('add_sale', { amount, paymentType: 'cash' }), `cash sale ${amount}`);
  add(`sold ${amount} cash`, call('add_sale', { amount, paymentType: 'cash' }), `sale ${amount} cash`);
  add(`stock count ${amount}`, call('record_inventory', { amount }), `inventory count ${amount}`);
  add(`inventory ${amount}`, call('record_inventory', { amount }), `inventory ${amount}`);
}

for (const party of parties) {
  for (const amount of [50, 100, 200, 400, 1200]) {
    add(`bill from ${party} for ${amount}`, call('add_bill', { amount, supplierName: party }), `supplier ${party} billed ${amount}`);
    add(`paid ${amount} to vendor ${party} by bank`, call('create_supplier_payment', { amount, supplierName: party, method: 'bank' }), `pay ${party} ${amount} bank`);
    add(`pay ${party} ${amount} cash`, call('create_supplier_payment', { amount, supplierName: party, method: 'cash' }), `supplier payment ${party} ${amount}`);
    add(`${party} deposited ${amount} capital`, call('add_capital', { amount, partnerName: party }), `capital deposit ${party} ${amount}`);
    add(`add capital ${amount} for ${party}`, call('add_capital', { amount, partnerName: party }), `add_capital ${party} ${amount}`);
    add(`withdraw ${amount} from ${party} capital`, call('create_drawing', { amount, partnerName: party }), `drawing ${party} ${amount}`);
    add(`${party} withdrew ${amount}`, call('create_drawing', { amount, partnerName: party }), `drawing ${party} ${amount}`);
    add(`received ${amount} from ${party} against the invoice`, call('create_receipt', { amount, customerName: party, mode: 'against_invoice' }), `receipt against invoice; do not invent invoiceId`);
    add(`received ${amount} from ${party}`, call('create_receipt', { amount, customerName: party, mode: 'against_invoice' }), `money in from ${party}`);
    add(`create invoice ${amount} for ${party}`, call('create_invoice', { amount, clientName: party }), `invoice ${party} ${amount}`);
    add(`quote ${amount} for ${party}`, call('create_quote', { amount, clientName: party }), `quote ${party} ${amount}`);
  }
  add(`add customer ${party}`, call('add_debtor', { name: party }), `create customer ${party}`);
  add(`add supplier ${party}`, call('add_supplier', { name: party }), `create supplier ${party}`);
}

for (const method of methods) {
  add(`record rent expense 1200 ${method}`, call('add_expense', { amount: 1200, category: 'rent', method }), `rent 1200 ${method}`);
  add(`personal lunch 12 ${method}`, call('log_personal_expense', { amount: 12, category: 'meals', method }), `personal meals 12 ${method}`);
}

add("what's my profit this month", [], 'question about reports, not a mutation');
add('how much cash do I have', [], 'question about cash, not a mutation');
add('show the balance sheet', [], 'report question, empty answers');
add('explain drawings', [], 'how-to question, empty answers');
add('delete the inventory count', [], 'inventory_count must not be deleted');
add('delete customer Acme', [], 'customers must not be deleted here');
add('delete supplier Rahim', [], 'suppliers must not be deleted here');
add('remove the stock count from yesterday', [], 'inventory counts are reversed, not deleted');
add("what's the weather", [], 'off-topic');
add('play some music', [], 'off-topic');
add('personal lunch 12 cash', call('log_personal_expense', { amount: 12, category: 'meals', method: 'cash' }), 'personal expense');
add('spent fifty on diesel in cash yesterday', call('add_expense', { amount: 50, category: 'fuel', method: 'cash' }), 'fifty = 50, diesel = fuel');
add('received 200 from Acme against the old invoice', call('create_receipt', { amount: 200, customerName: 'Acme', mode: 'against_invoice' }), 'do not invent invoiceId when several invoices could match');

const out = path.join(root, 'needle-ledgr.jsonl');
fs.writeFileSync(out, rows.map((row) => JSON.stringify(row)).join('\n'));
console.log(`Wrote ${rows.length} local examples to ${out} (no cloud API).`);
