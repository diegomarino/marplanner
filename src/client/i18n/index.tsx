import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { authFetch } from "@/lib/credential";
import { log } from "@/lib/logger";
import { useHouseholdSettingsContext } from "@/lib/householdSettings";
import { messages, resolveLang, type Language, type MessageKey } from "./messages";

interface TranslationContextType {
  language: Language;
  t: (key: MessageKey) => string;
}

/** The i18n missing-key signal is a telemetry write, not a bus event
 * (FR-009/INV-13/AC-08). In-memory seen-set, once per key+locale per session — a render loop
 * hitting the same fallback repeatedly must not flood the ingest flood bound. The payload
 * property is deliberately named `translationId`, NEVER `key` — the server's redaction deny-list
 * matches `/key/i` on property NAMES and would blank the identifier into uselessness.
 */
const seenMissingKeys = new Set<string>();

function reportMissingKey(translationId: MessageKey, locale: Language): void {
  const dedupeKey = `${locale}:${translationId}`;
  if (seenMissingKeys.has(dedupeKey)) return;
  seenMissingKeys.add(dedupeKey);
  log("warn", "i18n", "missing_key", { translationId, locale });
}

const TranslationContext = createContext<TranslationContextType | undefined>(undefined);

export function LanguageProvider({ children }: { children: ReactNode }) {
  // Consume the shell's HouseholdSettingsProvider
  // context when one is an ancestor — NO second `/api/settings` fetch (the hoisted
  // provider already fetched once). `undefined` (no ancestor provider at all) is the
  // ONLY case that falls back to the legacy self-fetch below — every existing
  // standalone render (tests, AdminGate rendered outside Shell) keeps working
  // unmodified, English-fallback included.
  const householdSettings = useHouseholdSettingsContext();
  const [language, setLanguage] = useState<Language>("en");

  useEffect(() => {
    if (householdSettings !== undefined) {
      if (householdSettings.language) {
        setLanguage(resolveLang(householdSettings.language));
      }
      return;
    }

    authFetch("/api/settings", { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`settings: ${res.status}`);
        return res.json() as Promise<{ locale: { language: string } }>;
      })
      .then((data) => {
        const rawLang = data?.locale?.language;
        setLanguage(resolveLang(rawLang));
      })
      .catch(() => {
        // future: could log or track this
        setLanguage("en");
      });
  }, [householdSettings]);

  const t = (key: MessageKey): string => {
    const localized = messages[language][key];
    if (localized === undefined) {
      reportMissingKey(key, language);
    }
    return localized ?? messages.en[key];
  };

  return (
    <TranslationContext.Provider value={{ language, t }}>{children}</TranslationContext.Provider>
  );
}

const englishFallback = {
  t: (key: MessageKey): string => {
    const value = messages.en[key];
    if (value === undefined) {
      reportMissingKey(key, "en");
    }
    return value ?? key;
  },
  language: "en" as Language,
};

export function useT() {
  const ctx = useContext(TranslationContext);
  if (!ctx) {
    return englishFallback.t;
  }
  return ctx.t;
}

export function useTranslation() {
  const ctx = useContext(TranslationContext);
  if (!ctx) {
    return englishFallback;
  }
  return ctx;
}
