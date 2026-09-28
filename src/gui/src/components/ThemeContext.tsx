import React, { createContext, useContext, useEffect, useState } from 'react';
import type { AccessibilitySettings } from '../../../domain/settings';

export type Theme = 'dark' | 'high-contrast';
export type Density = 'compact' | 'comfortable';

interface ThemeContextType {
  theme: Theme;
  reducedMotion: boolean;
  fontScale: number;
  density: Density;
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;
  setReducedMotion: (rm: boolean) => void;
  setFontScale: (fs: number) => void;
  setDensity: (d: Density) => void;
  applyAccessibility: (settings: Partial<AccessibilitySettings>) => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: 'dark',
  reducedMotion: false,
  fontScale: 1.0,
  density: 'comfortable',
  toggleTheme: () => {},
  setTheme: () => {},
  setReducedMotion: () => {},
  setFontScale: () => {},
  setDensity: () => {},
  applyAccessibility: () => {},
});

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const stored = sessionStorage.getItem('maos-theme');
      return stored === 'high-contrast' ? 'high-contrast' : 'dark';
    } catch {
      return 'dark';
    }
  });

  const [reducedMotion, setReducedMotionState] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem('maos-reduced-motion') === 'true';
    } catch {
      return false;
    }
  });

  const [fontScale, setFontScaleState] = useState<number>(() => {
    try {
      const stored = sessionStorage.getItem('maos-font-scale');
      if (stored) {
        const val = parseFloat(stored);
        if (!isNaN(val) && val >= 0.8 && val <= 2.0) return val;
      }
      return 1.0;
    } catch {
      return 1.0;
    }
  });

  const [density, setDensityState] = useState<Density>(() => {
    try {
      const stored = sessionStorage.getItem('maos-density');
      return stored === 'compact' ? 'compact' : 'comfortable';
    } catch {
      return 'comfortable';
    }
  });

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
    try {
      sessionStorage.setItem('maos-theme', newTheme);
    } catch {}
  };

  const setReducedMotion = (rm: boolean) => {
    setReducedMotionState(rm);
    try {
      sessionStorage.setItem('maos-reduced-motion', String(rm));
    } catch {}
  };

  const setFontScale = (scale: number) => {
    const clamped = Math.max(0.8, Math.min(2.0, scale));
    setFontScaleState(clamped);
    try {
      sessionStorage.setItem('maos-font-scale', String(clamped));
    } catch {}
  };

  const setDensity = (d: Density) => {
    setDensityState(d);
    try {
      sessionStorage.setItem('maos-density', d);
    } catch {}
  };

  const applyAccessibility = (settings: Partial<AccessibilitySettings>) => {
    if (settings.theme) setTheme(settings.theme);
    if (settings.reducedMotion !== undefined) setReducedMotion(settings.reducedMotion);
    if (settings.fontScale !== undefined) setFontScale(settings.fontScale);
    if (settings.density) setDensity(settings.density);
  };

  const toggleTheme = () => {
    setTheme(theme === 'dark' ? 'high-contrast' : 'dark');
  };

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-reduced-motion', reducedMotion ? 'true' : 'false');
    document.documentElement.setAttribute('data-density', density);
    document.documentElement.style.setProperty('--font-scale', String(fontScale));
  }, [theme, reducedMotion, density, fontScale]);

  return (
    <ThemeContext.Provider
      value={{
        theme,
        reducedMotion,
        fontScale,
        density,
        toggleTheme,
        setTheme,
        setReducedMotion,
        setFontScale,
        setDensity,
        applyAccessibility,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => useContext(ThemeContext);
