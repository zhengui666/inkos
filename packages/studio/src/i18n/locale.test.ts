import { describe, expect, it } from 'vitest';
import { formatDateTime, formatNumber, resolveLocale, translate } from './locale';
import { messages } from './messages';

describe('Studio locale preference', () => {
  it('honors a manual selection before browser preferences', () => {
    expect(resolveLocale('en', ['zh-CN'])).toBe('en');
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN');
  });
  it('matches supported language variants in preference order', () => {
    expect(resolveLocale(null, ['zh-Hans-CN', 'en-US'])).toBe('zh-CN');
    expect(resolveLocale(null, ['en-GB', 'zh-CN'])).toBe('en');
    expect(resolveLocale(null, ['ja', 'zh-TW'])).toBe('zh-CN');
  });
  it('falls back to English for unsupported languages and ignores invalid stored values', () => {
    expect(resolveLocale(null, ['fr', 'ja'])).toBe('en');
    expect(resolveLocale(null)).toBe('en');
    expect(resolveLocale('invalid', ['zh-CN'])).toBe('zh-CN');
  });
});

describe('Studio messages', () => {
  it('keeps English source copy and translates Chinese UI and native statuses', () => {
    expect(translate('en', 'Works & revisions')).toBe('Works & revisions');
    expect(translate('zh-CN', 'Works & revisions')).toBe('作品与版本');
    expect(translate('zh-CN', 'connected')).toBe('已连接');
    expect(translate('zh-CN', 'reviewing')).toBe('审核中');
  });
  it('interpolates whole sentences without interpreting inserted text', () => {
    expect(translate('en', '{count} artifacts', { count: 3 })).toBe('3 artifacts');
    expect(translate('zh-CN', '{count} artifacts', { count: 3 })).toBe('3 个内容产物');
    expect(translate('zh-CN', 'Target {name}', { name: 'A {name}' })).toBe('目标 A {name}');
    expect(translate('zh-CN', 'Target {name}')).toBe('目标 {name}');
  });
  it('preserves unknown extension labels and original evidence', () => {
    const original = '平台回执 / external.publisher / manuscript';
    expect(translate('zh-CN', original)).toBe(original);
    expect(translate('en', original)).toBe(original);
  });
  it('keeps every catalog message non-empty and preserves its interpolation fields', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    for (const [source, chinese] of Object.entries(messages)) {
      expect(chinese.trim(), source).not.toBe('');
      expect(placeholders(chinese), source).toEqual(placeholders(source));
    }
  });
});

describe('native locale formatting', () => {
  it('uses the selected locale for numbers and dates', () => {
    expect(formatNumber('en', 12345.67)).toBe(new Intl.NumberFormat('en').format(12345.67));
    expect(formatNumber('zh-CN', 12345.67)).toBe(new Intl.NumberFormat('zh-CN').format(12345.67));
    const date = '2026-10-12T10:30:00Z';
    expect(formatDateTime('zh-CN', date)).toBe(new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date)));
    expect(formatDateTime('en', date)).not.toBe(formatDateTime('zh-CN', date));
    expect(formatDateTime('en', 0)).not.toBe('—');
  });
  it('keeps absent and non-date native values readable', () => {
    expect(formatDateTime('zh-CN', null)).toBe('—');
    expect(formatDateTime('zh-CN', undefined)).toBe('—');
    expect(formatDateTime('zh-CN', 'unknown')).toBe('unknown');
  });
});
