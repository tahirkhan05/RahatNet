'use client';

import * as React from 'react';
import type { LangCode } from './translations';
import { getTranslation } from './translations';

const LANG_KEY = 'rahatnet-lang';

interface LanguageContextValue {
  lang: LangCode;
  setLang: (l: LangCode) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export const LanguageContext = React.createContext<LanguageContextValue>({
  lang: 'en',
  setLang: () => {},
  t: (key) => key,
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = React.useState<LangCode>('en');

  // Read from localStorage on mount
  React.useEffect(() => {
    const stored = localStorage.getItem(LANG_KEY) as LangCode | null;
    if (stored) setLangState(stored);
  }, []);

  const setLang = React.useCallback((l: LangCode) => {
    setLangState(l);
    localStorage.setItem(LANG_KEY, l);
  }, []);

  const t = React.useCallback(
    (key: string, params?: Record<string, string | number>) => getTranslation(lang, key, params),
    [lang],
  );

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLang() {
  return React.useContext(LanguageContext);
}
