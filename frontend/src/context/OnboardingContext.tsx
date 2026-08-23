import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

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
  const stateRequestId = useRef(0);

  const refreshOnboardingState = useCallback(async () => {
    const requestId = ++stateRequestId.current;
    let completed = false;
    try {
      completed = Boolean((await api.getSettings()).hasOnboarded);
    } catch {
      // Fail closed: if settings cannot be read, accounting screens must not be
      // exposed as though onboarding had completed.
      completed = false;
    }
    if (requestId !== stateRequestId.current) return completed;
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
      stateRequestId.current += 1;
      setHasOnboarded(false);
      setReady(true);
    },
    markOnboarded: () => {
      stateRequestId.current += 1;
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
