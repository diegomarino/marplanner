import { useId } from "react";
import { ChoreColumns } from "@/chores/ChoreColumns";
import { useTranslation } from "@/i18n";

export function TodayChores(): React.JSX.Element {
  const { t } = useTranslation();
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className="bg-card flex h-full min-h-0 flex-col rounded-3xl border p-4 shadow-sm"
    >
      <h2 id={headingId} className="mb-3 shrink-0 text-sm font-semibold uppercase tracking-wide">
        {t("todayChores.title")}
      </h2>
      <ChoreColumns layout="fit" />
    </section>
  );
}
