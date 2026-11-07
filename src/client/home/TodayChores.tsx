import { ChoreColumns } from "@/chores/ChoreColumns";
import { useTranslation } from "@/i18n";

export function TodayChores(): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <section
      aria-label={t("todayChores.title")}
      className="bg-card flex h-full min-h-0 flex-col rounded-3xl border p-4 shadow-sm"
    >
      <ChoreColumns layout="fit" />
    </section>
  );
}
