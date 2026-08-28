'use client';

import { useEffect, useRef } from 'react';

let cachedManager: unknown = null;

export function useProviderManagerInstance(): unknown {
  const ref = useRef<unknown>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (cachedManager) {
      ref.current = cachedManager;
      return;
    }
    let cancelled = false;
    (async () => {
      const mod = await import('@/providers');
      if (cancelled) return;
      cachedManager = mod.createProviderManager();
      ref.current = cachedManager;
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return ref.current;
}
