import { isLocale, LOCALE_NAMES, LOCALES } from "@altair/i18n";
import { useI18n } from "@altair/i18n/react";
import { Languages } from "lucide-react";
import { cn } from "../../lib/ui";

/** A compact language picker, for places outside the account menu (e.g. sign-in). */
export function LanguageSelect({ className = "" }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className={cn("inline-flex items-center gap-1.5 text-sm text-subtle", className)}>
      <Languages size={14} aria-hidden="true" />
      <span className="sr-only">{t("common.language")}</span>
      <select
        value={locale}
        onChange={(e) => isLocale(e.target.value) && setLocale(e.target.value)}
        className="cursor-pointer bg-transparent text-sm text-subtle outline-none hover:text-fg"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} className="bg-raised text-fg">
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
