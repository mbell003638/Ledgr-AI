import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { api } from '@/src/api';

type OnboardingGateContextValue = {
  ready: boolean;
  hasOnboarded: boolean;
  refreshOnboardingState: () => Promise<boolean>;
  requireOnboarding: () => void;
  markOnboarded: () => void;
};

const OnboardingGateContext = createContext<OnboardingGateContextValue | null>(null);

/**
 * Live route authorization for first-run setup.
 *
 * Persisted settings remain the source of truth. The two synchronous markers
 * keep Expo Router's protected routes in lockstep with successful factory reset
 * and onboarding writes, so stale navigation history can never expose the app.
 */
export function OnboardingGateProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [hasOnboarded, setHasOnboarded] = useState(false);

  const refreshOnboardingState = useCallback(async () => {
    let completed = false;
    try {
      completed = Boolean((await api.getSettings()).hasOnboarded);
    } catch {
      // Fail closed: if settings cannot be read, accounting screens must not be
      // exposed as though onboarding had completed.
      completed = false;
    }
    setHasOnboarded(completed);
    setReady(true);
    return completed;
  }, []);

  useEffect(() => {
    refreshOnboardingState();
  }, [refreshOnboardingState]);

  const value = useMemo<OnboardingGateContextValue>(() => ({
    ready,
    hasOnboarded,
    refreshOnboardingState,
    requireOnboarding: () => {
      setHasOnboarded(false);
      setReady(true);
    },
    markOnboarded: () => {
      setHasOnboarded(true);
      setReady(true);
    },
  }), [hasOnboarded, ready, refreshOnboardingState]);

  return <OnboardingGateContext.Provider value={value}>{children}</OnboardingGateContext.Provider>;
}

export function useOnboardingGate(): OnboardingGateContextValue {
  const value = useContext(OnboardingGateContext);
  if (!value) throw new Error('useOnboardingGate must be used inside OnboardingGateProvider');
  return value;
}
