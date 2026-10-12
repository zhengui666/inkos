import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setAppLanguage } from '../lib/app-language';
import { formatDateTime, formatNumber, LOCALE_STORAGE_KEY, resolveLocale, translate, type Locale } from './locale';

export type { Locale } from './locale';
type I18n = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (message: string, values?: Record<string, string | number>) => string;
  formatNumber: (value: number) => string;
  formatDateTime: (value: string | number | undefined | null) => string;
};
const Context = createContext<I18n>(null!);

function initialLocale(): Locale {
  let stored: string | null = null;
  try { stored = localStorage.getItem(LOCALE_STORAGE_KEY); } catch { /* Storage may be disabled. */ }
  return resolveLocale(stored, navigator.languages);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState<Locale>(initialLocale);
  const setLocale = useCallback((next: Locale) => {
    updateLocale(next);
    try { localStorage.setItem(LOCALE_STORAGE_KEY, next); } catch { /* Switching still works without storage. */ }
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    setAppLanguage(locale === 'en' ? 'en' : 'zh');
  }, [locale]);
  const value = useMemo<I18n>(() => ({
    locale, setLocale,
    t: (message, values) => translate(locale, message, values),
    formatNumber: number => formatNumber(locale, number),
    formatDateTime: date => formatDateTime(locale, date),
  }), [locale, setLocale]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useI18n = () => useContext(Context);
