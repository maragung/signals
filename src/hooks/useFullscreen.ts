'use client';

import { useEffect, useState, useCallback } from 'react';

export function useFullscreen<T extends HTMLElement>(): [
  React.RefObject<T>,
  boolean,
  () => void,
] {
  const ref = useState(() => ({ current: null as T | null }))[0];
  const [isFs, setIsFs] = useState(false);

  const toggle = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      void el.requestFullscreen?.();
    } else {
      void document.exitFullscreen?.();
    }
  }, [ref]);

  useEffect(() => {
    const onChange = () => setIsFs(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  return [ref as React.RefObject<T>, isFs, toggle];
}

// Local re-export of React to avoid an extra import line in components
import { useRef } from 'react';
