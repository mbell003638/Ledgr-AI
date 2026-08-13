import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Capital Account identity isolation', () => {
  it('keeps a Capital Account row on its member id even when a party has the same name', () => {
    const accounts = read('app/(tabs)/suppliers.tsx');
    expect(accounts).toContain('row.role === "partner" && row.id === investor.id');
    expect(accounts).toContain('mapped.push({ id: investor.id');
    expect(accounts).not.toContain('existing.role = "partner"');
    expect(accounts).not.toContain('!byName.has(investor.name.toLowerCase())');
  });

  it('does not redirect an existing Capital Account based only on a stale book style', () => {
    const detail = read('app/investor/[id].tsx');
    expect(detail).not.toContain("config?.style !== 'retail_partnership'");
    expect(detail).toContain('api.getInvestorLedger(id)');
  });

  it.each(['app/voice.tsx', 'src/components/VoiceFab.tsx'])('%s resolves roles before confirmation and never auto-creates a payment party', (file) => {
    const source = read(file);
    expect(source).toContain('resolveVoicePartyCommand');
    expect(source).toContain('api.listInvestors()');
    expect(source).toContain('api.drawInvestorFunds');
    expect(source).not.toContain('else { const c = await api.createSupplier({ name: parsed.supplierName })');
    expect(source).not.toContain('else { const c = await api.createDebtor({ name: parsed.customerName })');
  });
});
