import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useColorScheme } from 'react-native';
import { darkColors, lightColors, navyGoldColors, amoledBlueColors, spacing, radius, font, effects, motion, ThemeType } from '@/src/theme';

type Mode = 'light' | 'dark' | 'navy_gold' | 'amoled_blue' | 'system';

const STORAGE_KEY = 'theme_mode';
const ANIMATION_STORAGE_KEY = 'animations_enabled';

type Ctx = {
  theme: ThemeType;
  mode: Mode;
  effective: 'light' | 'dark' | 'navy_gold' | 'amoled_blue';
  setMode: (m: Mode) => void;
  animationsEnabled: boolean;
  setAnimationsEnabled: (enabled: boolean) => void;
};

const defaultCtx: Ctx = {
  theme: { color: lightColors, spacing, radius, font, effects, motion },
  mode: 'system',
  effective: 'light',
  setMode: () => {},
  animationsEnabled: false,
  setAnimationsEnabled: () => {},
};

const ThemeContext = createContext<Ctx>(defaultCtx);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [mode, setModeState] = useState<Mode>('system');
  const [hydrated, setHydrated] = useState(false);
  const [animationsEnabled, setAnimationsEnabledState] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const v = (await AsyncStorage.getItem(STORAGE_KEY)) as Mode | null;
        if (v === 'light' || v === 'dark' || v === 'navy_gold' || v === 'amoled_blue' || v === 'system') setModeState(v);
        setAnimationsEnabledState((await AsyncStorage.getItem(ANIMATION_STORAGE_KEY)) === 'true');
      } catch { /* ignore */ }
      finally { setHydrated(true); }
    })();
    // Safety: if AsyncStorage hangs, render with defaults after 3s
    const timer = setTimeout(() => setHydrated(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  const setMode = (m: Mode) => {
    setModeState(m);
    AsyncStorage.setItem(STORAGE_KEY, m).catch(() => {});
  };

  const setAnimationsEnabled = (enabled: boolean) => {
    setAnimationsEnabledState(enabled);
    AsyncStorage.setItem(ANIMATION_STORAGE_KEY, String(enabled)).catch(() => {});
  };

  const effective: 'light' | 'dark' | 'navy_gold' | 'amoled_blue' = mode === 'system' ? (system === 'dark' ? 'dark' : 'light') : mode;

  const colorMap = { light: lightColors, dark: darkColors, navy_gold: navyGoldColors, amoled_blue: amoledBlueColors };

  const value = useMemo<Ctx>(() => ({
    theme: {
      color: colorMap[effective],
      spacing, radius, font, effects, motion,
    },
    mode, effective, setMode, animationsEnabled, setAnimationsEnabled,
  }), [effective, mode, animationsEnabled]);

  if (!hydrated) return null;
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeType {
  return useContext(ThemeContext).theme;
}

export function useAnimations() {
  const { animationsEnabled, setAnimationsEnabled } = useContext(ThemeContext);
  return { animationsEnabled, setAnimationsEnabled };
}

export function useThemeMode() {
  const { mode, effective, setMode } = useContext(ThemeContext);
  return { mode, effective, setMode };
}
