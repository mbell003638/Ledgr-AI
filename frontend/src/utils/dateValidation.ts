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
