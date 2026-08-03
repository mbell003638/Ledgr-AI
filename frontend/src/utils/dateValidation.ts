export function isValidDateString(dateStr: string): boolean {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  return d.toISOString().startsWith(dateStr);
}

/**
 * Returns today's date as a YYYY-MM-DD string built from LOCAL date
 * components (not UTC). Using toISOString().slice(0, 10) yields the UTC day,
 * which is wrong for UTC+ users near midnight (e.g. DRC at UTC+1/+2: an entry
 * made at 00:30 local would otherwise be dated to the previous day).
 */
export function localTodayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Fold the digit + whitespace variants a real Android keyboard / OS autofill can
 * inject into a plain ASCII string:
 *  - strips leading/trailing and internal exotic whitespace (NBSP U+00A0,
 *    narrow-NBSP U+202F, thin space, zero-width, etc.)
 *  - converts non-ASCII decimal digits (Arabic-Indic ٠-٩, Devanagari ०-९,
 *    Bengali, fullwidth ０-９, …) to ASCII 0-9 so "٢٠٢٦-٠٨-٠٣" parses.
 */
function toAsciiDigits(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    // Any Unicode decimal digit: fold to its 0-9 value via the code-point gap
    // to the block's zero. String(Number) handles the common blocks reliably;
    // fall back to a per-block table for the ones JS's Number() won't take.
    if (/\d/.test(ch)) { out += ch; continue; }
    const folded = FOLD_DIGIT[ch];
    if (folded !== undefined) { out += folded; continue; }
    out += ch;
  }
  return out;
}

// Non-ASCII decimal digit blocks the app is realistically exposed to.
const FOLD_DIGIT: Record<string, string> = (() => {
  const table: Record<string, string> = {};
  const zeros = [
    0x0660, // Arabic-Indic
    0x06f0, // Extended Arabic-Indic (Persian/Urdu)
    0x0966, // Devanagari
    0x09e6, // Bengali
    0x0a66, // Gurmukhi
    0x0be6, // Tamil
    0xff10, // Fullwidth
  ];
  for (const zero of zeros) {
    for (let d = 0; d < 10; d++) table[String.fromCodePoint(zero + d)] = String(d);
  }
  return table;
})();

/**
 * Normalize a manually-typed date into strict canonical `YYYY-MM-DD`, or return
 * the cleaned string unchanged when it can't be safely canonicalized (so the
 * caller's isValidDateString still rejects genuine junk).
 *
 * Accepts, and canonicalizes:
 *  - '2026-08-03'                     → '2026-08-03'   (already canonical)
 *  - '  2026-08-03 '                  → '2026-08-03'   (whitespace / NBSP trim)
 *  - '2026-8-3'                       → '2026-08-03'   (single-digit m/d, year first)
 *  - '2026/8/3'                       → '2026-08-03'   (slash separators, year first)
 *  - '03/08/2026' / '3-8-2026'        → '2026-08-03'   (day-first, year last)
 *  - Arabic-Indic / fullwidth digits  → folded to ASCII first
 *
 * Ambiguity rule: when a 4-digit group is present it is the year. A year-first
 * string is read Y-M-D; a year-last string is read day-first (D-M-Y), matching
 * the app's international (DRC / DD/MM) audience. Truly ambiguous or impossible
 * dates are left cleaned-but-unchanged for the validator to reject.
 */
export function normalizeDateInput(input: string | null | undefined): string {
  if (input == null) return '';
  // Fold exotic digits, then collapse ALL Unicode whitespace to nothing at the
  // edges and normalize any internal run to a single ASCII space for splitting.
  const ascii = toAsciiDigits(String(input));
  const cleaned = ascii.replace(/[\s  ​‌‍﻿]+/g, ' ').trim();
  if (!cleaned) return '';

  // Split on any of - / . or spaces between the three components.
  const parts = cleaned.split(/[\/\-.\s]+/).filter(Boolean);
  if (parts.length !== 3 || parts.some((p) => !/^\d{1,4}$/.test(p))) {
    // Not three numeric groups — hand back the trimmed/folded string as-is.
    return cleaned;
  }

  const [a, b, c] = parts;
  let year: string, month: string, day: string;
  if (a.length === 4) {
    // Year-first: YYYY-M-D
    year = a; month = b; day = c;
  } else if (c.length === 4) {
    // Year-last: day-first D-M-YYYY (international default)
    year = c; month = b; day = a;
  } else {
    // No unambiguous 4-digit year — leave for the validator to reject.
    return cleaned;
  }

  const y = Number(year), m = Number(month), d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return cleaned; // impossible → reject downstream
  const canonical = `${year.padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // Final guard: only return the canonical form if it is a real calendar date
  // (isValidDateString catches e.g. 2026-02-31). Otherwise return cleaned so the
  // caller still surfaces an error rather than silently accepting.
  return isValidDateString(canonical) ? canonical : cleaned;
}
