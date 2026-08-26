import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const home = fs.readFileSync(path.join(root, 'app', '(tabs)', 'index.tsx'), 'utf8');
const advanced = fs.readFileSync(path.join(root, 'app', 'advanced-settings.tsx'), 'utf8');
const workflows = fs.readFileSync(path.join(root, 'app', 'workflows.tsx'), 'utf8');
const health = fs.readFileSync(path.join(root, 'src', 'utils', 'bookHealth.ts'), 'utf8');
const expenses = fs.readFileSync(path.join(root, 'app', 'expenses.tsx'), 'utf8');

describe('phase 0-3 workspace UI contracts', () => {
  it('exposes quick start, Book Health and all workflows without another tab', () => {
    expect(home).toContain('workspace-quick-start');
    expect(home).toContain("router.push('/workflows' as any)");
    expect(advanced).toContain('hosting-mode-summary');
    expect(advanced).toContain("router.push('/book-health' as any)");
    expect(workflows).toContain('Only enabled workflows appear here');
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
