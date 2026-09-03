/**
 * Builds a Ledgr Needle fine-tune JSONL from templates + the golden set.
 * Run: node ./scripts/on-device-ai/generate-needle-dataset.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)));
const amounts = [12, 50, 80, 100, 200, 400, 1200, 5000, 15000];
const methods = ['cash', 'bank', 'card'];
const parties = ['Acme', 'Rahim', 'Amit', 'Sara', 'Fuel Station'];

const rows = [];
const add = (transcript, name, args) => {
  rows.push({
    messages: [{ role: 'user', content: transcript }],
    tools: name ? [{ type: 'function', function: { name, arguments: JSON.stringify(args) } }] : [],
  });
};

for (const amount of amounts) {
  add(`expense ${amount} fuel cash`, 'add_expense', { amount, category: 'fuel', method: 'cash' });
  add(`spent ${amount} on diesel in cash`, 'add_expense', { amount, category: 'fuel', method: 'cash' });
  add(`cash sale ${amount}`, 'add_sale', { amount, paymentType: 'cash' });
  add(`bill from Acme for ${amount}`, 'add_bill', { amount, supplierName: 'Acme' });
  add(`paid ${amount} to vendor Rahim by bank`, 'create_supplier_payment', { amount, supplierName: 'Rahim', method: 'bank' });
  add(`Amit deposited ${amount} capital`, 'add_capital', { amount, partnerName: 'Amit' });
  add(`withdraw ${amount} from Amit capital`, 'create_drawing', { amount, partnerName: 'Amit' });
  add(`received ${amount} from Acme against the invoice`, 'create_receipt', { amount, customerName: 'Acme', mode: 'against_invoice' });
  add(`stock count ${amount}`, 'record_inventory', { amount });
}

for (const party of parties) {
  add(`create invoice 400 for ${party}`, 'create_invoice', { amount: 400, clientName: party });
}

for (const method of methods) {
  add(`record rent expense 1200 ${method}`, 'add_expense', { amount: 1200, category: 'rent', method });
}

add("what's my profit this month", null, {});
add('how much cash do I have', null, {});
add('delete the inventory count', null, {});
add('delete customer Acme', null, {});
add('personal lunch 12 cash', 'log_personal_expense', { amount: 12, category: 'meals', method: 'cash' });

const out = path.join(root, 'needle-ledgr.jsonl');
fs.writeFileSync(out, rows.map((row) => JSON.stringify(row)).join('\n'));
console.log(`Wrote ${rows.length} examples to ${out}`);
