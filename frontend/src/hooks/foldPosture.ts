import { useEffect, useState } from "react";

export type FoldPosture = "unknown" | "flat" | "halfOpened" | "tabletop" | "book";

export type HingeRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type FoldPostureSnapshot = {
  posture: FoldPosture;
  hasHinge: boolean;
  dualPane: boolean;
  hingeRect: HingeRect | null;
};

export type FoldPostureAdapter = {
  getSnapshot?: () => FoldPostureSnapshot;
  subscribe?: (listener: (snapshot: FoldPostureSnapshot) => void) => () => void;
};

export const UNKNOWN_FOLD_POSTURE: FoldPostureSnapshot = {
  posture: "unknown",
  hasHinge: false,
  dualPane: false,
  hingeRect: null,
};

let configuredAdapter: FoldPostureAdapter | null = null;

/**
 * Native hosts may register a WindowManager/FoldingFeature adapter at startup.
 * The app never infers a hinge or dual pane from width alone; absent an adapter,
 * this remains the ordinary single-pane phone/tablet experience.
 */
export function configureFoldPostureAdapter(adapter: FoldPostureAdapter | null): void {
  configuredAdapter = adapter;
}

export function getConfiguredFoldPostureAdapter(): FoldPostureAdapter | null {
  return configuredAdapter;
}

export function useFoldPosture(): FoldPostureSnapshot {
  const [snapshot, setSnapshot] = useState<FoldPostureSnapshot>(() => {
    const adapter = configuredAdapter;
    return adapter?.getSnapshot?.() ?? UNKNOWN_FOLD_POSTURE;
  });

  useEffect(() => {
    const adapter = configuredAdapter;
    if (!adapter) {
      setSnapshot(UNKNOWN_FOLD_POSTURE);
      return undefined;
    }

    setSnapshot(adapter.getSnapshot?.() ?? UNKNOWN_FOLD_POSTURE);
    return adapter.subscribe?.(setSnapshot);
  }, []);

  return snapshot;
}
