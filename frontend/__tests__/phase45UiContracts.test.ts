import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const backup = fs.readFileSync(path.join(root, 'app', 'backup-recovery.tsx'), 'utf8');
const bankPreview = fs.readFileSync(path.join(root, 'app', 'bank-import-preview.tsx'), 'utf8');
const experiments = fs.readFileSync(path.join(root, 'src', 'utils', 'experimentalModules.ts'), 'utf8');
const advanced = fs.readFileSync(path.join(root, 'app', 'advanced-settings.tsx'), 'utf8');

describe('phase 4-5 UI safety contracts', () => {
  it('routes new backups through encryption, preflight, authentication and the existing importer', () => {
    expect(backup).toContain('encryptBackup(raw, exportPassphrase)');
    expect(backup).toContain('api.validateBackupForImport(payload)');
    expect(backup).toContain("requireAuth('Confirm encrypted backup restore')");
    expect(backup).toContain("api.importBackup({ ...payload, mode: 'replace' })");
    expect(advanced).toContain("router.push('/backup-recovery' as any)");
  });

  it('keeps bank import preview disconnected from accounting APIs', () => {
    expect(bankPreview).toContain('no ledger posting');
    expect(bankPreview).not.toContain('api.');
    expect(bankPreview).not.toContain('createTransaction');
    expect(bankPreview).not.toContain('createCash');
  });

  it('does not assign routes to blocked accounting modules', () => {
    expect(experiments).toContain("status: 'blocked'");
    expect(experiments).toContain("key: 'manufacturing'");
    expect(experiments).toContain("key: 'fixed_assets'");
  });
});
