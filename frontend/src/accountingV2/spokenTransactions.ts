const AMOUNT_TOKEN = /(?:[$€£₹]\s*)?\d[\d,]*(?:\.\d{1,2})?(?:\s*(?:[$€£₹]|\b(?:USD|CAD|EUR|GBP|INR)\b))?/gi;
const VERB = /^(?:I\s+)?(paid|pay|paying|spent|spend|received?|collected?|sold|bought|purchased?|withdrew|withdraw|invested|contributed)\b/i;
const NEXT_TRANSACTION = /\s+(?:and\s+(?:then\s+|also\s+)?|then\s+|plus\s+|;\s*)(?=(?:I\s+)?(?:paid|pay|paying|spent|spend|received?|collected?|sold|bought|purchased?|withdrew|withdraw|invested|contributed)|(?:[$€£₹]?\s*\d))/i;

function stripDateTokens(text: string): string {
  return text
    .replace(/\b\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}\b/g, ' ')
    .replace(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}\b/g, ' ');
}

/** Counts positive money amounts, ignoring calendar dates and years. */
export function countSpokenAmounts(text: string): number {
  const matches = stripDateTokens(text).match(AMOUNT_TOKEN) || [];
  return matches.filter((token) => {
    const amount = Number(token.replace(/[^0-9.]/g, ''));
    return Number.isFinite(amount) && amount > 0 && !(Number.isInteger(amount) && amount >= 1900 && amount <= 2100);
  }).length;
}

/**
 * Splits “paid 100 to Amit and 50 to Rahim” into one utterance per amount.
 * “paid 100 to Make and Sons” stays one utterance because the second clause
 * has no amount.
 */
export function splitSpokenTransactions(text: string): string[] {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  if (countSpokenAmounts(cleaned) < 2) return [cleaned];

  let parts = cleaned.split(NEXT_TRANSACTION).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    parts = cleaned.split(/\s+and\s+(?=[$€£₹]?\s*\d)/i).map((part) => part.trim()).filter(Boolean);
  }
  if (parts.length < 2) return [cleaned];

  const verb = parts[0].match(VERB)?.[1];
  const filled = parts.map((part, index) => {
    if (index === 0 || !verb || VERB.test(part)) return part;
    return `${verb} ${part}`;
  }).filter((part) => countSpokenAmounts(part) >= 1);

  return filled.length >= 2 ? filled : [cleaned];
}
