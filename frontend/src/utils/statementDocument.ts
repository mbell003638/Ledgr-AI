export type StatementDocumentInput = {
  businessName: string;
  title: string;
  from?: string;
  to?: string;
  text: string;
  accent?: string;
  landscape?: boolean;
};

type StatementRow = { label: string; value?: string; detail?: boolean };
type StatementSection = { title: string; rows: StatementRow[] };

const escapeHtml = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function splitRow(line: string): StatementRow {
  const colon = line.indexOf(':');
  if (colon > 0) return { label: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() };
  return { label: line.trim(), detail: true };
}

function parseSections(text: string): StatementSection[] {
  const sections: StatementSection[] = [];
  let current: StatementSection | undefined;
  const isHeading = (line: string) => {
    const cleaned = line.replace(/^[-—\s]+/, '').trim();
    return Boolean(cleaned) && !cleaned.includes(':') && cleaned === cleaned.toUpperCase() && /[A-Z]/.test(cleaned);
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^Ledgr Custom Report$/i.test(line) || /— .* Report$/i.test(line) || /^Source:/i.test(line) || /^Period:/i.test(line) || /^\\d{4}-\\d{2}-\\d{2}\\s*→/.test(line) || /^— Sent from Ledgr$/i.test(line)) continue;
    const markerHeading = line.startsWith('—') && !/Sent from/i.test(line);
    if (markerHeading || isHeading(line)) {
      const title = line.replace(/^[-—\s]+/, '').trim();
      current = { title, rows: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { title: '', rows: [] };
      sections.push(current);
    }
    current.rows.push(splitRow(line));
  }
  return sections.filter((section) => section.rows.length || section.title);
}

function renderRows(rows: StatementRow[]) {
  return rows.map((row) => {
    if (row.detail) return `<div class="detail-row">${escapeHtml(row.label)}</div>`;
    const total = /^(total|net profit|gross profit|equity|closing capital|.*ending stake)/i.test(row.label);
    const negative = /^[-−]/.test(String(row.value || ''));
    const positive = /^\+/.test(String(row.value || ''));
    return `<div class="statement-row${total ? ' total-row' : ''}">
      <span>${escapeHtml(row.label)}</span>
      <strong class="${negative ? 'negative' : positive ? 'positive' : ''}">${escapeHtml(row.value)}</strong>
    </div>`;
  }).join('');
}

function renderSection(section: StatementSection, className = '') {
  return `<section class="statement-section ${className}">
    ${section.title ? `<h2>${escapeHtml(section.title)}</h2>` : ''}
    ${renderRows(section.rows)}
  </section>`;
}

/** A print-safe statement shared by standard and custom financial reports. */
export function buildStatementDocument(input: StatementDocumentInput): string {
  const sections = parseSections(input.text);
  const profitIndex = sections.findIndex((section) => /profit|summary/i.test(section.title));
  const profit = profitIndex >= 0 ? sections.splice(profitIndex, 1)[0] : undefined;
  const assets = sections.filter((section) => /asset/i.test(section.title));
  const liabilities = sections.filter((section) => /liabilit|drawing/i.test(section.title));
  const reconciliation = sections.filter((section) => /partner|stake|reconciliation|capital/i.test(section.title));
  const remaining = sections.filter((section) => !assets.includes(section) && !liabilities.includes(section) && !reconciliation.includes(section));
  const generated = new Date().toLocaleString();
  const period = input.from && input.to ? `${input.from} to ${input.to}` : input.from || input.to || 'All time';
  const accent = input.accent || '#b8860b';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(input.title)}</title>
<style>
  @page { size: ${input.landscape ? 'A4 landscape' : 'A4 portrait'}; margin: 10mm; }
  * { box-sizing: border-box; }
  body { margin:0; background:#eef1ee; color:#33433a; font-family:Arial, Helvetica, sans-serif; font-size:11px; line-height:1.34; }
  .paper { width:100%; max-width:820px; margin:0 auto; background:#fff; padding:22px; min-height:100vh; border-radius:8px; box-shadow:0 4px 18px rgba(25,47,35,.12); }
  .header { padding-bottom:12px; border-bottom:1px solid #d9ddd8; }
  .title { margin:0; color:#34473b; font-family:Georgia, serif; font-size:17px; font-weight:700; }
  .meta { display:flex; flex-wrap:wrap; gap:5px 18px; margin-top:3px; color:#7c857e; font-size:9px; }
  .profit-card { background:#ecf7f0; border:1px solid #bddfc9; border-radius:8px; padding:11px 15px; margin:16px 0 14px; }
  .profit-card h2 { display:none; }
  .columns { display:grid; grid-template-columns:1fr 1fr; gap:18px; align-items:start; }
  .statement-section { margin:0 0 15px; break-inside:avoid; }
  .statement-section h2 { margin:0 0 5px; color:#9a7a22; font-size:9px; letter-spacing:.8px; text-transform:uppercase; }
  .statement-row { display:flex; justify-content:space-between; gap:18px; padding:4px 0; border-bottom:1px solid #e8e1d3; color:#796e60; }
  .statement-row strong { color:#4b453d; font-family:'Courier New', monospace; font-size:11px; white-space:nowrap; text-align:right; }
  .statement-row.total-row { border-top:1.5px solid #514b42; border-bottom:0; margin-top:3px; padding-top:6px; font-weight:700; color:#403a34; }
  .statement-row.total-row strong { font-weight:700; }
  .positive { color:#39765d !important; }
  .negative { color:#b3473c !important; }
  .detail-row { padding:4px 0; color:#6e776f; border-bottom:1px solid #edf0eb; white-space:pre-wrap; }
  .reconciliation { margin-top:4px; padding:14px 15px; background:#f6f3ea; border:1px solid #e0d7bd; border-radius:8px; }
  .reconciliation h2 { color:${accent}; font-size:13px; letter-spacing:0; text-transform:none; }
  .rest { margin-top:8px; padding-top:12px; border-top:1px solid #e1e6df; }
  .footer { margin-top:20px; padding-top:8px; border-top:1px solid #d9ddd8; color:#8b938c; font-size:9px; display:flex; justify-content:space-between; gap:12px; }
  @media print { body { background:#fff; } .paper { max-width:none; min-height:0; padding:0; border-radius:0; box-shadow:none; } }
  @media (max-width:540px) { .paper{padding:14px}.columns{grid-template-columns:1fr}.footer{display:block}.footer span+span{display:block;margin-top:3px} }
</style></head><body><main class="paper">
  <header class="header"><h1 class="title">${escapeHtml(input.title)}</h1><div class="meta"><span>${escapeHtml(period)}</span><span>Generated ${escapeHtml(generated)}</span><span>${escapeHtml(input.businessName || 'Ledgr')}</span></div></header>
  ${profit ? `<div class="profit-card">${renderSection(profit)}</div>` : ''}
  ${(assets.length || liabilities.length) ? `<div class="columns"><div>${assets.map((section) => renderSection(section)).join('')}</div><div>${liabilities.map((section) => renderSection(section)).join('')}</div></div>` : ''}
  ${reconciliation.map((section) => renderSection(section, 'reconciliation')).join('')}
  ${remaining.length ? `<div class="rest">${remaining.map((section) => renderSection(section)).join('')}</div>` : ''}
  <footer class="footer"><span>Generated by Ledgr</span><span>Financial statement · ${escapeHtml(input.businessName || 'Ledgr')}</span></footer>
</main></body></html>`;
}