import { useCallback, useRef, useState } from 'react';
import { InteractionManager } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { getDataVersion, getCached, setCached } from '@/src/utils/dataVersion';

/**
 * useScreenData — standard focus-load lifecycle for list/detail screens, with
 * data-version-aware invalidation and an in-memory last-known-data cache.
 *
 * Behaviour:
 *  - On first focus it runs `loader()` (deferred past the navigation animation
 *    via InteractionManager so the transition doesn't jank), shows the spinner,
 *    and caches the result keyed by `cacheKey`.
 *  - On subsequent focuses it reloads ONLY if the global data version advanced
 *    since the last successful load (i.e. a mutation happened). Otherwise it
 *    reuses the already-in-state data and does no work — back-navigation is
 *    instant.
 *  - If a fresh cache entry exists it is applied synchronously so the screen
 *    paints real data immediately instead of a spinner.
 *  - `refresh()` always forces a reload (pull-to-refresh), regardless of
 *    version, and toggles `refreshing` instead of `loading`.
 *
 * The loader is expected to be stable (wrap in useCallback). Its resolved value
 * is stored in `data` and cached.
 */
export function useScreenData<T>(
  cacheKey: string,
  loader: () => Promise<T>,
): {
  data: T | undefined;
  loading: boolean;
  refreshing: boolean;
  /** Force a reload now (e.g. after an in-screen mutation). */
  reload: () => void;
  /** Pull-to-refresh: force reload with the refreshing indicator. */
  refresh: () => void;
} {
  const cached = getCached<T>(cacheKey);
  const [data, setData] = useState<T | undefined>(cached?.data);
  const [loading, setLoading] = useState<boolean>(cached == null);
  const [refreshing, setRefreshing] = useState(false);

  // Version at which `data` was last loaded. Starts at the cached version (or
  // -1 so the first focus always loads). `hasData` mirrors whether we currently
  // hold a payload — both are refs so the focus effect never reads a stale
  // closure value when deciding whether it can skip the reload.
  const loadedVersion = useRef<number>(cached?.version ?? -1);
  const hasData = useRef<boolean>(cached != null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const run = useCallback(
    async (mode: 'focus' | 'refresh') => {
      if (mode === 'refresh') setRefreshing(true);
      try {
        const result = await loaderRef.current();
        setData(result);
        setCached(cacheKey, result);
        loadedVersion.current = getDataVersion();
        hasData.current = true;
      } catch {
        // Swallow — screens historically console.warn; keep last-known data.
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [cacheKey],
  );

  useFocusEffect(
    useCallback(() => {
      const currentVersion = getDataVersion();
      const upToDate = hasData.current && loadedVersion.current === currentVersion;
      if (upToDate) {
        // Nothing changed since our last load — skip the work entirely.
        return;
      }
      // Defer the heavy load past the navigation/entering animation so the
      // transition stays smooth on low-end devices.
      const task = InteractionManager.runAfterInteractions(() => {
        run('focus');
      });
      return () => task.cancel();

    }, [run]),
  );

  const reload = useCallback(() => {
    run('focus');
  }, [run]);

  const refresh = useCallback(() => {
    run('refresh');
  }, [run]);

  return { data, loading, refreshing, reload, refresh };
}
