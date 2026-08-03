import { localTodayIso, isValidDateString, normalizeDateInput } from '../src/utils/dateValidation';

describe('localTodayIso', () => {
  it('returns a string in YYYY-MM-DD format', () => {
    expect(localTodayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('matches LOCAL date components (not UTC)', () => {
    // Build the expected value from a local Date the same way the util does.
    const d = new Date();
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`;
    expect(localTodayIso()).toBe(expected);
  });

  it('zero-pads month and day to two digits', () => {
    const result = localTodayIso();
    const [year, month, day] = result.split('-');
    expect(year).toHaveLength(4);
    expect(month).toHaveLength(2);
    expect(day).toHaveLength(2);
    // Numeric ranges sanity-check the padding is real, not just length.
    expect(Number(month)).toBeGreaterThanOrEqual(1);
    expect(Number(month)).toBeLessThanOrEqual(12);
    expect(Number(day)).toBeGreaterThanOrEqual(1);
    expect(Number(day)).toBeLessThanOrEqual(31);
  });

  it('produces a string accepted by isValidDateString', () => {
    expect(isValidDateString(localTodayIso())).toBe(true);
  });

  // [Penny M2] Late-evening UTC+ boundary: a user at UTC+2 filling in an entry
  // at 00:30 local is still on the NEW day locally, but toISOString() (UTC)
  // would report the PREVIOUS day. localTodayIso must follow the local day.
  //
  // We fake the clock to an instant that is a *different calendar day* in UTC
  // vs. the runner's local zone. Rather than depend on a specific TZ (jest's TZ
  // mocking is unreliable here), we assert localTodayIso tracks the LOCAL
  // components of the faked instant and, crucially, that it can differ from the
  // UTC slice at the boundary.
  describe('late-evening / after-midnight boundary (faked clock)', () => {
    beforeAll(() => {
      jest.useFakeTimers();
    });
    afterAll(() => {
      jest.useRealTimers();
    });

    it('uses the LOCAL calendar day at an after-midnight instant', () => {
      // 2026-03-15T00:30 in the runner's LOCAL zone.
      const localInstant = new Date(2026, 2, 15, 0, 30, 0);
      jest.setSystemTime(localInstant);
      expect(localTodayIso()).toBe('2026-03-15');
    });

    it('would disagree with the naive UTC slice when local/UTC days differ', () => {
      // Construct an instant where the local day and the UTC day are guaranteed
      // to differ: local midnight + 30 min. If the runner is at UTC+X (X>0),
      // the UTC slice lands on the previous day; localTodayIso must not.
      const localInstant = new Date(2026, 5, 1, 0, 30, 0); // 2026-06-01 local
      jest.setSystemTime(localInstant);

      const local = localTodayIso();
      const utcSlice = new Date().toISOString().slice(0, 10);

      // localTodayIso always reflects the local calendar day.
      expect(local).toBe('2026-06-01');

      // If this runner is in a UTC+ zone, the naive UTC slice is the bug we fix:
      // it reports the previous day. This documents the divergence when present;
      // in UTC/UTC- zones the two legitimately match, so we only assert the
      // inequality direction (local >= utcSlice), never a hard mismatch.
      expect(local >= utcSlice).toBe(true);
    });
  });
});

describe('normalizeDateInput', () => {
  it('passes through an already-canonical YYYY-MM-DD', () => {
    expect(normalizeDateInput('2026-08-03')).toBe('2026-08-03');
  });

  it('trims leading/trailing whitespace (incl. NBSP)', () => {
    expect(normalizeDateInput(' 2026-08-03 ')).toBe('2026-08-03');
    // U+00A0 non-breaking space + U+202F narrow NBSP (Android autofill / paste).
    expect(normalizeDateInput(' 2026-08-03 ')).toBe('2026-08-03');
  });

  it('zero-pads single-digit month/day (year-first)', () => {
    expect(normalizeDateInput('2026-8-3')).toBe('2026-08-03');
    expect(normalizeDateInput('2026/8/3')).toBe('2026-08-03');
  });

  it('accepts day-first DD/MM/YYYY and D-M-YYYY (year last)', () => {
    expect(normalizeDateInput('03/08/2026')).toBe('2026-08-03');
    expect(normalizeDateInput('3-8-2026')).toBe('2026-08-03');
    expect(normalizeDateInput('3.8.2026')).toBe('2026-08-03');
  });

  it('folds non-ASCII (Arabic-Indic / fullwidth) digits to ASCII', () => {
    // Arabic-Indic ٢٠٢٦-٠٨-٠٣
    expect(normalizeDateInput('٢٠٢٦-٠٨-٠٣')).toBe('2026-08-03');
    // Fullwidth ２０２６-０８-０３
    expect(normalizeDateInput('２０２６-０８-０３')).toBe('2026-08-03');
  });

  // [Samsung keypad] Real-device bug: Samsung numeric keypads emit U+2212 MINUS
  // SIGN (and friends) for the "-" key, producing a visually perfect
  // "2026-08-03" that string-compares as junk. All dash lookalikes must fold
  // to ASCII '-' before parsing.
  describe('dash-lookalike folding', () => {
    it('folds U+2212 minus sign (Samsung numeric keypad)', () => {
      expect(normalizeDateInput('2026−08−03')).toBe('2026-08-03');
    });

    it('folds en dash (U+2013) and em dash (U+2014)', () => {
      expect(normalizeDateInput('2026–08–03')).toBe('2026-08-03');
      expect(normalizeDateInput('2026—08—03')).toBe('2026-08-03');
    });

    it('folds hyphen, non-breaking hyphen, figure dash, horizontal bar, small and fullwidth hyphen-minus', () => {
      for (const dash of ['‐', '‑', '‒', '―', '﹣', '－']) {
        expect(normalizeDateInput(`2026${dash}08${dash}03`)).toBe('2026-08-03');
      }
    });

    it('accepts dot separators (some keypads favor ".")', () => {
      expect(normalizeDateInput('2026.08.03')).toBe('2026-08-03');
    });

    it('handles mixed separators with dash lookalikes and single digits', () => {
      expect(normalizeDateInput('2026−8.3')).toBe('2026-08-03');
    });

    it('strips invisible soft hyphens (U+00AD) contaminating the string', () => {
      expect(normalizeDateInput('2026­-08-0­3')).toBe('2026-08-03');
      // Soft hyphen where the separator should be is NOT a separator — it is
      // stripped, leaving junk the validator must reject.
      expect(isValidDateString(normalizeDateInput('2026­08­03'))).toBe(false);
    });

    it('dash-variant input round-trips through isValidDateString', () => {
      for (const raw of ['2026−08−03', '2026–08–03', '2026.08.03', '03−08−2026']) {
        expect(isValidDateString(normalizeDateInput(raw))).toBe(true);
      }
    });

    it('junk with dash lookalikes still fails', () => {
      for (const junk of ['−−−', '2026−13−40', 'ab–cd–ef', '..', '­']) {
        expect(isValidDateString(normalizeDateInput(junk))).toBe(false);
      }
    });
  });

  it('leaves genuine junk unchanged (still rejected by isValidDateString)', () => {
    for (const junk of ['not a date', '2026', 'xx-yy-zz', '2026-13-40', '2026-02-31', '']) {
      const out = normalizeDateInput(junk);
      expect(isValidDateString(out)).toBe(false);
    }
  });

  it('normalized output round-trips through isValidDateString', () => {
    for (const raw of ['2026-08-03', ' 2026-8-3 ', '03/08/2026', '3-8-2026']) {
      expect(isValidDateString(normalizeDateInput(raw))).toBe(true);
    }
  });

  it('handles null/undefined defensively', () => {
    expect(normalizeDateInput(null)).toBe('');
    expect(normalizeDateInput(undefined)).toBe('');
  });
});
