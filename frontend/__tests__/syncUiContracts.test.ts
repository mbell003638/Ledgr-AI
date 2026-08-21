import fs from 'node:fs';
import path from 'node:path';

const appRoot = path.resolve(__dirname, '..', 'app');
const syncSettings = fs.readFileSync(path.join(appRoot, 'sync-settings.tsx'), 'utf8');
const mainSettings = fs.readFileSync(path.join(appRoot, '(tabs)', 'settings.tsx'), 'utf8');
const advancedSettings = fs.readFileSync(path.join(appRoot, 'advanced-settings.tsx'), 'utf8');

describe('sync UI contracts', () => {
  it('keeps the enrollment header compact and the manual token reachable above the keyboard', () => {
    expect(syncSettings).toContain('KeyboardAvoidingView');
    expect(syncSettings).toContain("behavior={Platform.OS === 'ios' ? 'padding' : 'height'}");
    expect(syncSettings).toContain('keyboardDismissMode="on-drag"');
    expect(syncSettings).toContain('scrollRef.current?.scrollToEnd');
    expect(syncSettings).toContain('paddingBottom: 160');
    expect(syncSettings).toContain('headerTitle: { fontSize: 23, lineHeight: 29');
  });

  it('keeps one sync navigation entry and retains the conflict inbox in Advanced Settings', () => {
    expect(mainSettings).not.toContain('testID="open-sync-settings"');
    expect(advancedSettings).toContain("router.push('/sync-settings' as any)");
    expect(advancedSettings).toContain("router.push('/sync-conflicts' as any)");
  });
});
