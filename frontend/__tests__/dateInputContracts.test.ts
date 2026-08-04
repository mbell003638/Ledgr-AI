import fs from 'fs';
import path from 'path';

/**
 * Regression tripwire for the Samsung date-input bug class.
 *
 * Every screen that lets the user TYPE a date must route it through
 * `normalizeDateInput()` + `isValidDateString()` from src/utils/dateValidation.
 * Inline `\d{4}-\d{2}-\d{2}` regexes reject legitimate input (dash lookalikes
 * such as U+2212 from Samsung keypads, DD/MM order, exotic digits) and — in two
 * real shipped cases — were written with doubled backslashes (`\\d`) that
 * rejected EVERYTHING. This scan keeps future screens from reintroducing either.
 */
const root = path.join(__dirname, '..');

const sourceFilesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(entryPath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });

const appFiles = sourceFilesUnder(path.join(root, 'app'));

// Matches an inline date regex whether written correctly (/\d{4}-\d{2}-\d{2}/)
// or with the doubled-backslash mistake (/\\d{4}-\\d{2}-\\d{2}/).
const INLINE_DATE_REGEX = /\\{1,2}d\{4\}-\\{1,2}d\{2\}-\\{1,2}d\{2\}/;

describe('date input contracts (app/ screens)', () => {
  it('no app screen contains a raw \\d{4}-\\d{2}-\\d{2} inline date regex', () => {
    const offenders = appFiles.filter((file) => INLINE_DATE_REGEX.test(fs.readFileSync(file, 'utf8')));
    expect(offenders.map((file) => path.relative(root, file))).toEqual([]);
  });

  it('every app screen with a typed YYYY-MM-DD input imports and uses normalizeDateInput + isValidDateString', () => {
    const screensWithDateInputs = appFiles.filter((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return /placeholder="[^"]*YYYY-MM-DD/.test(source);
    });

    // Sanity: the sweep must actually be scanning real screens.
    expect(screensWithDateInputs.length).toBeGreaterThan(0);

    for (const file of screensWithDateInputs) {
      const source = fs.readFileSync(file, 'utf8');
      const relative = path.relative(root, file);
      expect(`${relative}: ${source.includes('normalizeDateInput')}`).toBe(`${relative}: true`);
      expect(`${relative}: ${source.includes('isValidDateString')}`).toBe(`${relative}: true`);
    }
  });
});
