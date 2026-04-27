'use client';

/**
 * ThemeProvider wraps the app with next-themes so every component can call
 * `useTheme()` to read or toggle the colour scheme.
 *
 * We use the `class` strategy so Tailwind's `dark:` variants activate when
 * the `dark` class is present on <html>. The `disableTransitionOnChange`
 * flag prevents the flash of un-themed content during the class swap.
 */

import * as React from 'react';
import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ThemeProviderProps } from 'next-themes/dist/types';

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
