import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useColorScheme } from 'react-native';
import { darkColors, lightColors, spacing, radius, font, ThemeType } from '@/src/theme';

type Mode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'theme_mode';

type Ctx = {
  theme: ThemeType;
  mode: Mode;
  effective: 'light' | 'dark';
  setMode: (m: Mode) => void;
};

const defaultCtx: Ctx = {
  theme: { color: lightColors, spacing, radius, font },
  mode: 'system',
  effective: 'light',
  setMode: () => {},
};

const ThemeContext = createContext<Ctx>(defaultCtx);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [mode, setModeState] = useState<Mode>('system');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const v = (await AsyncStorage.getItem(STORAGE_KEY)) as Mode | null;
        if (v === 'light' || v === 'dark' || v === 'system') setModeState(v);
      } finally { setHydrated(true); }
    })();
  }, []);

  const setMode = (m: Mode) => {
    setModeState(m);
    AsyncStorage.setItem(STORAGE_KEY, m).catch(() => {});
  };

  const effective: 'light' | 'dark' = mode === 'system' ? (system === 'dark' ? 'dark' : 'light') : mode;

  const value = useMemo<Ctx>(() => ({
    theme: {
      color: effective === 'dark' ? darkColors : lightColors,
      spacing, radius, font,
    },
    mode, effective, setMode,
  }), [effective, mode]);

  if (!hydrated) return null;
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeType {
  return useContext(ThemeContext).theme;
}

export function useThemeMode() {
  const { mode, effective, setMode } = useContext(ThemeContext);
  return { mode, effective, setMode };
}
