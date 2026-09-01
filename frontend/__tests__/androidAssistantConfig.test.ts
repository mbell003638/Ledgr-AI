import fs from 'fs';
import path from 'path';

describe('Android Assistant native configuration', () => {
  const root = path.resolve(__dirname, '..');
  it('registers the config plugin and required Android permissions', () => {
    const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
    expect(app.expo.plugins).toContain('./plugins/withAndroidAssistant');
    expect(app.expo.android.permissions).toEqual(expect.arrayContaining(['RECORD_AUDIO', 'INTERNET']));
  });

  it('plugin source is declarative and does not write accounting data', () => {
    const source = fs.readFileSync(path.join(root, 'plugins', 'withAndroidAssistant.js'), 'utf8');
    expect(source).toContain('withAndroidManifest');
    expect(source).toContain('android.intent.action.VIEW');
    expect(source).toContain('shortcuts.xml');
    expect(source).toContain('withStringsXml');
    expect(source).toContain('@string/ledgr_shortcut_ask_ai');
    expect(source).not.toMatch(/android:shortcutShortLabel="(?!@string\/)/);
    expect(source).not.toMatch(/insert|journal|ledgerWrite|postEntry/i);
  });
});

