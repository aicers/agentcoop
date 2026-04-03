/**
 * Internationalization module.
 *
 * Provides a global message catalog initialised once at startup based
 * on the language stored in `~/.agentcoop/config.json`.  All
 * user-facing text is accessed via the `t` accessor.
 *
 * Agent prompts, log output, and GitHub comments are intentionally
 * excluded — they always use English regardless of the UI language.
 */

import { en } from "./en.js";
import type { Messages } from "./messages.js";

export type { Messages } from "./messages.js";

export type Language = "en" | "ko";

const catalogs: Record<Language, () => Promise<Messages>> = {
  en: async () => (await import("./en.js")).en,
  ko: async () => (await import("./ko.js")).ko,
};

let current: Messages = en;

/**
 * Initialise the i18n module with the given language.
 * Should be called once at startup.  When not called, English is used.
 */
export async function initI18n(language: Language): Promise<void> {
  const load = catalogs[language] ?? catalogs.en;
  current = await load();
}

/**
 * Return the current message catalog.
 *
 * Defaults to English when `initI18n` has not been called (e.g. in
 * tests or before startup completes).
 */
export function t(): Messages {
  return current;
}
