/**
 * useTheme Hook
 *
 * Access host theme CSS custom properties.
 */

import { useState, useEffect } from 'react';

export interface AppTheme {
  background: string;
  foreground: string;
  accent: string;
  isDark: boolean;
}

export function useTheme(): AppTheme {
  const [theme, setTheme] = useState<AppTheme>({
    background: '#ffffff',
    foreground: '#000000',
    accent: '#0066ff',
    isDark: false,
  });

  useEffect(() => {
    const update = () => {
      const style = getComputedStyle(document.documentElement);
      setTheme({
        background: style.getPropertyValue('--background').trim() || '#ffffff',
        foreground: style.getPropertyValue('--foreground').trim() || '#000000',
        accent: style.getPropertyValue('--accent').trim() || '#0066ff',
        isDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
      });
    };

    update();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  return theme;
}
