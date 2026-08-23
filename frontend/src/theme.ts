export const lightColors = {
  surface: '#F6F7F5',
  onSurface: '#111513',
  surfaceSecondary: '#FFFFFF',
  glassSurface: 'rgba(255, 255, 255, 0.88)',
  glassSurfaceHover: 'rgba(255, 255, 255, 1)',
  glassBorder: '#E2E5DF',
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
  glassSurface: 'rgba(23, 27, 24, 0.78)',
  glassSurfaceHover: 'rgba(32, 37, 31, 0.92)',
  glassBorder: 'rgba(255, 255, 255, 0.09)',
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
  muted: '#A0AAA2',
  successBg: '#1A2C21',
  errorBg: '#2C1A18',
};

export const navyGoldColors: typeof lightColors = {
  surface: '#000000',
  onSurface: '#f5f6f8',
  surfaceSecondary: '#0A0A0C',
  glassSurface: 'rgba(18, 20, 28, 0.75)',
  glassSurfaceHover: 'rgba(28, 30, 42, 0.90)',
  glassBorder: 'rgba(255, 255, 255, 0.09)',
  onSurfaceSecondary: '#ffffff',
  surfaceTertiary: '#141418',
  onSurfaceTertiary: '#d0d4e4',
  surfaceInverse: '#ffffff',
  onSurfaceInverse: '#000000',
  brand: '#FDBA21',
  brandPrimary: '#FDBA21',
  onBrandPrimary: '#000000',
  brandSecondary: '#FFD475',
  onBrandSecondary: '#000000',
  brandTertiary: '#1A1A1F',
  onBrandTertiary: '#FDBA21',
  success: '#2ecc71',
  warning: '#f1c40f',
  error: '#e74c3c',
  info: '#3498db',
  border: '#1A1A20',
  borderStrong: '#2A2A35',
  divider: '#1A1A20',
  muted: '#ADB5CC',
  successBg: '#0D1F14',
  errorBg: '#1F0D0B',
};

export const amoledBlueColors: typeof lightColors = {
  surface: '#000000',
  onSurface: '#E8EAED',
  surfaceSecondary: '#0A0A0E',
  glassSurface: 'rgba(18, 19, 26, 0.78)',
  glassSurfaceHover: 'rgba(26, 28, 40, 0.92)',
  glassBorder: 'rgba(255, 255, 255, 0.09)',
  onSurfaceSecondary: '#F0F2F5',
  surfaceTertiary: '#12131A',
  onSurfaceTertiary: '#B0B8C8',
  surfaceInverse: '#F0F2F5',
  onSurfaceInverse: '#000000',
  brand: '#4A9EFF',
  brandPrimary: '#4A9EFF',
  onBrandPrimary: '#000000',
  brandSecondary: '#7FBFFF',
  onBrandSecondary: '#000000',
  brandTertiary: '#0D1525',
  onBrandTertiary: '#4A9EFF',
  success: '#34D399',
  warning: '#FBBF24',
  error: '#F87171',
  info: '#60A5FA',
  border: '#151520',
  borderStrong: '#252535',
  divider: '#151520',
  muted: '#9AA5C0',
  successBg: '#0D1F17',
  errorBg: '#1F0D0D',
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 };
export const radius = {
  sm: 6,
  md: 12,
  input: 14,
  button: 16,
  kpi: 18,
  lg: 20,
  card: 22,
  hero: 24,
  sheet: 32,
  pill: 999,
};
export const font = { displayBold: '700' as const, displaySemi: '600' as const, body: '400' as const, medium: '500' as const };

// Motion and effect values are shared by the native pilot so the HTML
// prototype's glow and spring language stays consistent across components.
export const effects = {
  topHighlightOpacity: 0.4,
  glowOpacity: 0.35,
  glowRadius: 20,
  strongGlowRadius: 28,
  glassOpacity: 0.78,
};

export const motion = {
  fast: 200,
  standard: 250,
  expressive: 350,
  longPress: 450,
  spring: { damping: 18, stiffness: 220, mass: 0.7 },
  sheetSpring: { damping: 18, stiffness: 190, mass: 0.8 },
};

// Static fallback (used by files not yet refactored, defaults to light)
export const theme = { color: lightColors, spacing, radius, font, effects, motion };
export type ThemeType = {
  color: typeof lightColors;
  spacing: typeof spacing;
  radius: typeof radius;
  font: typeof font;
  effects: typeof effects;
  motion: typeof motion;
};

export const fmt = (n: number | null | undefined, currencySymbol = '$') => {
  const v = Number(n ?? 0);
  const s = v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currencySymbol}${s}`;
};

export const shortDate = (iso?: string) => {
  if (!iso) return '';
  const str = String(iso).slice(0, 10);
  const parts = str.split('-');
  if (parts.length === 3) {
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    const d = parseInt(parts[2], 10);
    if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
      const dt = new Date(y, m, d);
      return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }
  }
  const d = new Date(iso);
  if (isNaN(d.getTime())) return str;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
