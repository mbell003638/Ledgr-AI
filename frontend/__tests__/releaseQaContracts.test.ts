import fs from 'fs';
import path from 'path';

const {
  ALLOWED_ANDROID_PERMISSIONS,
  REQUIRED_BLOCKED_PERMISSIONS,
  validateAndroidConfig,
} = require('../scripts/qa-release.js'); // eslint-disable-line @typescript-eslint/no-require-imports

function validExpoConfig() {
  return {
    version: '1.0.0',
    android: {
      package: 'com.ahem.ledgrai',
      allowBackup: false,
      versionCode: 1,
      permissions: [...ALLOWED_ANDROID_PERMISSIONS],
      blockedPermissions: REQUIRED_BLOCKED_PERMISSIONS.map((name: string) => `android.permission.${name}`),
    },
  };
}

describe('Play-release Android configuration gate', () => {
  it('accepts the repository app.json configuration', () => {
    const appJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));
    expect(() => validateAndroidConfig(appJson.expo)).not.toThrow();
  });

  it('accepts only the approved permissions with every required manifest block', () => {
    expect(() => validateAndroidConfig(validExpoConfig())).not.toThrow();
  });

  it('rejects an unexpected permission even when it is not in a small blacklist', () => {
    const config = validExpoConfig();
    config.android.permissions.push('READ_CALENDAR');
    expect(() => validateAndroidConfig(config)).toThrow(/unexpected: READ_CALENDAR/);
  });

  it('rejects a missing required blocked permission', () => {
    const config = validExpoConfig();
    config.android.blockedPermissions = config.android.blockedPermissions
      .filter((permission: string) => !permission.endsWith('SYSTEM_ALERT_WINDOW'));
    expect(() => validateAndroidConfig(config)).toThrow(/SYSTEM_ALERT_WINDOW/);
  });
});

describe('Android build workflow', () => {
  it('runs the shared Play-release software gate before building', () => {
    const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'build-apk.yml'), 'utf8');
    const testJob = workflow.slice(workflow.indexOf('  test:'), workflow.indexOf('  build:'));
    expect(testJob).toContain('npm run qa:release');
    expect(testJob).not.toContain('npx jest');
    expect(testJob).not.toContain('npx tsc');
  });
});
