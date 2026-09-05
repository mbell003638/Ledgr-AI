import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const backup = fs.readFileSync(path.join(root, 'app', 'backup-recovery.tsx'), 'utf8');
const bankPreview = fs.readFileSync(path.join(root, 'app', 'bank-import-preview.tsx'), 'utf8');
const experiments = fs.readFileSync(path.join(root, 'src', 'utils', 'experimentalModules.ts'), 'utf8');
const advanced = fs.readFileSync(path.join(root, 'app', 'advanced-settings.tsx'), 'utf8');
const bookHealth = fs.readFileSync(path.join(root, 'app', 'book-health.tsx'), 'utf8');
const syncSettings = fs.readFileSync(path.join(root, 'app', 'sync-settings.tsx'), 'utf8');
const selfHostGuide = fs.readFileSync(path.join(root, 'app', 'self-host-guide.tsx'), 'utf8');

describe('phase 4-5 UI safety contracts', () => {
  it('routes new backups through encryption, preflight, authentication and the existing importer', () => {
    expect(backup).toContain('encryptBackup(raw, exportPassphrase)');
    expect(backup).toContain('api.validateBackupForImport(payload)');
    expect(backup).toContain("requireAuth('Confirm encrypted backup restore')");
    expect(backup).toContain("api.importBackup({ ...payload, mode: 'replace' })");
    expect(advanced).toContain("router.push('/backup-recovery' as any)");
    expect(bookHealth).not.toContain("router.push('/backup-recovery' as any)");
    expect(bookHealth).not.toContain("router.push('/sync-settings' as any)");
  });

  it('keeps bank import preview disconnected from accounting APIs', () => {
    expect(advanced).toContain("router.push('/bank-import-preview' as any)");
    expect(advanced).not.toContain('open-experimental-modules');
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

  it('supports one-time QR invitations without placing credentials in the code', () => {
    expect(syncSettings).toContain('scan-sync-setup');
    expect(syncSettings).toContain('parseSyncSetupQr');
    expect(syncSettings).toContain('create-sync-invitation-qr');
    expect(syncSettings).toContain('createSyncEnrollmentCode');
    expect(syncSettings).toContain('redeemSyncEnrollmentCode');
    expect(syncSettings).toContain('createSyncSetupQr');
    // The QR is rendered with the qrcode + react-native-svg pair the app
    // already ships, rather than pulling in react-native-qrcode-svg.
    expect(syncSettings).toContain("from 'qrcode'");
    expect(syncSettings).toContain("from 'react-native-svg'");
  });

  it('provides an in-app self-host setup guide with platform downloads and pairing handoff', () => {
    expect(syncSettings).toContain("router.push('/self-host-guide' as any)");
    expect(selfHostGuide).toContain('ledgr-selfhost-install.ps1');
    expect(selfHostGuide).toContain('ledgr-selfhost-install.sh');
    expect(selfHostGuide).toContain('ledgr-selfhost-bundle.tar.gz');
    expect(selfHostGuide).toContain('open-sync-settings-from-guide');
    expect(selfHostGuide).toContain('administrator permission');
  });
});
