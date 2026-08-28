export const COMPACT_HEADER_BREAKPOINT = 390;

export function isCompactHeaderWidth(width: number): boolean {
  return Number.isFinite(width) && width > 0 && width < COMPACT_HEADER_BREAKPOINT;
}
