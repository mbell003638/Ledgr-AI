export const lightColors = {
  surface: '#F6F7F5',
  onSurface: '#111513',
  surfaceSecondary: '#FFFFFF',
  onSurfaceSecondary: '#1C221F',
  surfaceTertiary: '#EAECE7',
  onSurfaceTertiary: '#3B4540',
  surfaceInverse: '#111513',
  onSurfaceInverse: '#F6F7F5',
  brand: '#1C4030',
  brandPrimary: '#1C4030',
  onBrandPrimary: '#FFFFFF',
  brandSecondary: '#4A6E5C',
  onBrandSecondary: '#FFFFFF',
  brandTertiary: '#D6E5DB',
  onBrandTertiary: '#1C4030',
  success: '#2D6B45',
  warning: '#B87A1E',
  error: '#B83A2E',
  info: '#4A6E5C',
  border: '#E2E5DF',
  borderStrong: '#B4BDB7',
  divider: '#E2E5DF',
  muted: '#8A938E',
  successBg: '#E7F1EA',
  errorBg: '#FBE8E5',
};

export const darkColors: typeof lightColors = {
  surface: '#0E1210',
  onSurface: '#F1F3EE',
  surfaceSecondary: '#171B18',
  onSurfaceSecondary: '#E5E8E2',
  surfaceTertiary: '#20251F',
  onSurfaceTertiary: '#C8CDC4',
  surfaceInverse: '#F1F3EE',
  onSurfaceInverse: '#0E1210',
  brand: '#8FB99A',
  brandPrimary: '#8FB99A',
  onBrandPrimary: '#0E1210',
  brandSecondary: '#B0CDB8',
  onBrandSecondary: '#0E1210',
  brandTertiary: '#243B2E',
  onBrandTertiary: '#B0CDB8',
  success: '#7BC392',
  warning: '#E4B061',
  error: '#EE7C6E',
  info: '#B0CDB8',
  border: '#252A25',
  borderStrong: '#3A403A',
  divider: '#252A25',
  muted: '#7E877F',
  successBg: '#1A2C21',
  errorBg: '#2C1A18',
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 };
export const radius = { sm: 6, md: 12, lg: 20, pill: 999 };
export const font = { displayBold: '700' as const, displaySemi: '600' as const, body: '400' as const, medium: '500' as const };

// Static fallback (used by files not yet refactored, defaults to light)
export const theme = { color: lightColors, spacing, radius, font };
export type ThemeType = { color: typeof lightColors; spacing: typeof spacing; radius: typeof radius; font: typeof font };

export const fmt = (n: number | null | undefined, _currency?: string) => {
  const v = Number(n ?? 0);
  const s = v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `$${s}`;
};

export const shortDate = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
