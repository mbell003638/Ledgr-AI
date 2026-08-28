export const COMPACT_HEADER_BREAKPOINT = 480;
export const QUICK_ACTION_MIN_BOTTOM_INSET = 16;
export const QUICK_ACTION_FAB_OFFSET = 26;
export const QUICK_ACTION_MENU_OFFSET = 82;
export const QUICK_ACTION_MENU_TOP_GUTTER = 12;

export function isCompactHeaderWidth(width: number): boolean {
  return Number.isFinite(width) && width > 0 && width < COMPACT_HEADER_BREAKPOINT;
}

function normalizedInset(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function quickActionFabBottom(bottomInset: number): number {
  return Math.max(normalizedInset(bottomInset), QUICK_ACTION_MIN_BOTTOM_INSET) + QUICK_ACTION_FAB_OFFSET;
}

export function quickActionMenuBottom(bottomInset: number): number {
  return Math.max(normalizedInset(bottomInset), QUICK_ACTION_MIN_BOTTOM_INSET) + QUICK_ACTION_MENU_OFFSET;
}

export function quickActionMenuWidth(screenWidth: number, leftInset: number, rightInset: number): number {
  const width = Number.isFinite(screenWidth) ? Math.max(0, screenWidth) : 0;
  return Math.max(0, Math.min(410, width - normalizedInset(leftInset) - normalizedInset(rightInset) - 24));
}

export function quickActionMenuMaxHeight(screenHeight: number, topInset: number, bottomInset: number): number {
  const height = Number.isFinite(screenHeight) ? Math.max(0, screenHeight) : 0;
  const available = height - normalizedInset(topInset) - quickActionMenuBottom(bottomInset) - QUICK_ACTION_MENU_TOP_GUTTER;
  return Math.max(0, Math.min(620, Math.floor(available)));
}
