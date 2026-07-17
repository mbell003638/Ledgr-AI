export const theme = {
  color: {
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
  },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 },
  radius: { sm: 6, md: 12, lg: 20, pill: 999 },
  font: {
    displayBold: '700' as const,
    displaySemi: '600' as const,
    body: '400' as const,
    medium: '500' as const,
  },
};

export const fmt = (n: number | null | undefined, currency: 'USD' | 'CDF' = 'USD') => {
  const v = Number(n ?? 0);
  const s = v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'USD' ? `$${s}` : `${s} FC`;
};

export const shortDate = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
