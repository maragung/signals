'use client';

import { useEffect, useState } from 'react';

let cachedManager: unknown = null;

export function useProviderManagerInstance(): unknown {
  const [manager, setManager] = useState<unknown>(cachedManager);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (cachedManager) {
      setManager(cachedManager);
      return;
    }
    let cancelled = false;
    (async () => {
      const mod = await import('@/providers');
      if (cancelled) return;
      cachedManager = mod.createProviderManager();
      if (!cancelled) setManager(cachedManager);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return manager;
}
