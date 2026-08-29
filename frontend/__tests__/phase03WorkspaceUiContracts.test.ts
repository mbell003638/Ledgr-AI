import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const home = fs.readFileSync(path.join(root, 'app', '(tabs)', 'index.tsx'), 'utf8');
const advanced = fs.readFileSync(path.join(root, 'app', 'advanced-settings.tsx'), 'utf8');
const workflows = fs.readFileSync(path.join(root, 'app', 'workflows.tsx'), 'utf8');
const health = fs.readFileSync(path.join(root, 'src', 'utils', 'bookHealth.ts'), 'utf8');
const expenses = fs.readFileSync(path.join(root, 'app', 'expenses.tsx'), 'utf8');

describe('phase 0-3 workspace UI contracts', () => {
  it('avoids a duplicate workspace card and keeps system tools in a collapsed group', () => {
    expect(home).not.toContain('workspace-quick-start');
    expect(advanced).toContain('title="System & Workflows"');
    expect(advanced).toContain('hosting-mode-summary');
    expect(advanced).toContain("router.push('/book-health' as any)");
    expect(workflows).toContain('Only enabled workflows appear here');
  });

  it('keeps the expanded system tools as one flat, grouped surface', () => {
    expect(advanced).toContain('paddingTop: 24, paddingBottom: SETTINGS_SCREEN_HEADER_BOTTOM + 6');
    expect(advanced).toContain('minHeight: 60');
    expect(advanced).toContain('paddingVertical: 16');
    expect(advanced).toContain('paddingTop: theme.spacing.sm');
    expect(advanced).toContain('paddingVertical: 18');
    expect(advanced).toContain('Book Health');
    expect(advanced).toContain('Bank Statement Preview');
    expect(advanced).toContain('Self-hosted Sync');
    expect(advanced).toContain('Sync Conflict Inbox');
    expect(advanced).toContain('style={styles.workflowSection}');
    expect(advanced).toContain('style={styles.workflowContent}');
    expect(advanced).toContain('style={styles.workflowRow}');
    expect(advanced).toContain('styles.workflowRowLast');
    expect(advanced).toContain('borderTopWidth: StyleSheet.hairlineWidth');
  });

  it('keeps Book Health read-only and scopes journal checks through entries', () => {
    expect(health).toContain('WHERE j.book_id=?');
    expect(health).not.toContain('INSERT INTO');
    expect(health).not.toContain('UPDATE ');
    expect(health).not.toContain('DELETE FROM');
  });

  it('uses expense suggestions only to fill the existing category field', () => {
    expect(expenses).toContain('expenseCategorySuggestions(settings)');
    expect(expenses).toContain('onPress={() => setCategory(suggestion.label)}');
  });
});
