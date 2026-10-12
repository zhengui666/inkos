/** Normalize line endings and a browser-omitted final newline, never prose or internal spacing. */
export function normalizeMegaNovelBodyText(content: string): string {
  return content.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '');
}
