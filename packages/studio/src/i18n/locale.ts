import { messages } from './messages';

export type Locale = 'en' | 'zh-CN';
export const LOCALE_STORAGE_KEY = 'inkos-studio-language';

export function resolveLocale(stored: string | null, languages: readonly string[] = []): Locale {
  if (stored === 'en' || stored === 'zh-CN') return stored;
  for (const language of languages) {
    const base = language.toLowerCase().split('-')[0];
    if (base === 'zh') return 'zh-CN';
    if (base === 'en') return 'en';
  }
  return 'en';
}

export function translate(locale: Locale, message: string, values: Record<string, string | number> = {}): string {
  const template = locale === 'zh-CN' && Object.hasOwn(messages, message) ? messages[message] : message;
  return template.replace(/\{(\w+)\}/g, (placeholder, key: string) => Object.hasOwn(values, key) ? String(values[key]) : placeholder);
}

export function formatNumber(locale: Locale, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatDateTime(locale: Locale, value: string | number | undefined | null): string {
  if (value === undefined || value === null || value === '') return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
