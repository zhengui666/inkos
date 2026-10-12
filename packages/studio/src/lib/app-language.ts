// Retained non-React display helpers share the interface language selected by I18nProvider.
// Manuscript locale and project configuration are independent of this preference.
export type AppLanguage = "zh" | "en";

let current: AppLanguage = "zh";

export function setAppLanguage(lang: AppLanguage): void {
  current = lang;
}

export function getAppLanguage(): AppLanguage {
  return current;
}

/** Inline bilingual copy for retained non-React helpers; I18nProvider synchronizes the selection. */
export function tr(zh: string, en: string): string {
  return current === "en" ? en : zh;
}
