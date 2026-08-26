export type BankPreviewDirection = 'inflow' | 'outflow';
export type BankPreviewRow = {
  id: string;
  sourceLine: number;
  date: string;
  description: string;
  amount: number;
  direction: BankPreviewDirection;
  duplicate: boolean;
  valid: boolean;
  issue?: string;
};

export type BankPreviewResult = {
  rows: BankPreviewRow[];
  headers: string[];
  delimiter: ',' | ';' | '\t';
  validCount: number;
  duplicateCount: number;
  invalidCount: number;
};

function parseLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = ''; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { cells.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted value.');
  cells.push(cell.trim());
  return cells;
}

function completeRecords(text: string): string[] {
  const records: string[] = [];
  let record = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { record += '""'; i += 1; continue; }
      quoted = !quoted; record += char; continue;
    }
    if ((char === '\n' || char === '\r') && !quoted) {
      if (record.trim()) records.push(record);
      record = '';
      if (char === '\r' && text[i + 1] === '\n') i += 1;
    } else record += char;
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted value.');
  if (record.trim()) records.push(record);
  return records;
}

function normalizeHeader(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }
function column(headers: string[], names: string[]): number { return headers.findIndex((header) => names.includes(header)); }

function parseAmount(value: string): number | null {
  if (!value?.trim()) return null;
  const negative = /^\s*\(.*\)\s*$/.test(value) || /^\s*-/.test(value);
  const cleaned = value.replace(/[(),\s]/g, '').replace(/[^0-9.+-]/g, '');
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -Math.abs(parsed) : parsed;
}

function normalizedDate(value: string): string | null {
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(`${raw}T00:00:00Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw ? null : raw;
  }
  const match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!match) return null;
  const month = Number(match[1]); const day = Number(match[2]); const year = Number(match[3]);
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
}

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `bank-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function parseBankCsvPreview(text: string, knownFingerprints: Iterable<string> = []): BankPreviewResult {
  if (typeof text !== 'string' || !text.trim()) throw new Error('The selected CSV file is empty.');
  if (text.length > 5_000_000) throw new Error('The CSV file is too large for a safe on-device preview.');
  const records = completeRecords(text.replace(/^\uFEFF/, ''));
  if (records.length < 2) throw new Error('The CSV must contain a header row and at least one transaction.');
  const scores = ([',', ';', '\t'] as const).map((delimiter) => ({ delimiter, count: parseLine(records[0], delimiter).length }));
  scores.sort((a, b) => b.count - a.count);
  const delimiter = scores[0].delimiter;
  const headers = parseLine(records[0], delimiter).map(normalizeHeader);
  const dateIndex = column(headers, ['date', 'transaction_date', 'posted_date', 'posting_date']);
  const descriptionIndex = column(headers, ['description', 'details', 'memo', 'narration', 'transaction_description']);
  const amountIndex = column(headers, ['amount', 'transaction_amount']);
  const debitIndex = column(headers, ['debit', 'withdrawal', 'money_out']);
  const creditIndex = column(headers, ['credit', 'deposit', 'money_in']);
  if (dateIndex < 0 || descriptionIndex < 0 || (amountIndex < 0 && debitIndex < 0 && creditIndex < 0)) throw new Error('CSV needs date, description, and amount—or debit/credit—columns.');

  const seen = new Set(knownFingerprints);
  const rows = records.slice(1, 1001).map((record, index): BankPreviewRow => {
    const cells = parseLine(record, delimiter);
    const date = normalizedDate(cells[dateIndex] || '');
    const description = (cells[descriptionIndex] || '').trim().slice(0, 300);
    const direct = amountIndex >= 0 ? parseAmount(cells[amountIndex] || '') : null;
    const debit = debitIndex >= 0 ? parseAmount(cells[debitIndex] || '') : null;
    const credit = creditIndex >= 0 ? parseAmount(cells[creditIndex] || '') : null;
    const signed = direct !== null ? direct : credit !== null && credit !== 0 ? Math.abs(credit) : debit !== null ? -Math.abs(debit) : null;
    const issue = !date ? 'Invalid or unsupported date' : !description ? 'Missing description' : signed === null || signed === 0 ? 'Missing or zero amount' : undefined;
    const canonical = `${date || cells[dateIndex] || ''}|${description.toLowerCase()}|${signed ?? ''}`;
    const id = fingerprint(canonical);
    const duplicate = seen.has(id);
    seen.add(id);
    return { id, sourceLine: index + 2, date: date || cells[dateIndex] || '', description, amount: Math.abs(signed || 0), direction: (signed || 0) < 0 ? 'outflow' : 'inflow', duplicate, valid: !issue, ...(issue ? { issue } : {}) };
  });
  return { rows, headers, delimiter, validCount: rows.filter((row) => row.valid && !row.duplicate).length, duplicateCount: rows.filter((row) => row.duplicate).length, invalidCount: rows.filter((row) => !row.valid).length };
}
