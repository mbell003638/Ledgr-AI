export const COMPACT_HEADER_BREAKPOINT = 390;
export const QUICK_ACTION_MENU_BOTTOM = 98;
export const QUICK_ACTION_MENU_TOP_GUTTER = 12;

export function isCompactHeaderWidth(width: number): boolean {
  return Number.isFinite(width) && width > 0 && width < COMPACT_HEADER_BREAKPOINT;
}

export function quickActionMenuMaxHeight(screenHeight: number, topInset: number): number {
  const height = Number.isFinite(screenHeight) ? Math.max(0, screenHeight) : 0;
  const inset = Number.isFinite(topInset) ? Math.max(0, topInset) : 0;
  return Math.max(120, Math.floor(height - inset - QUICK_ACTION_MENU_BOTTOM - QUICK_ACTION_MENU_TOP_GUTTER));
}
