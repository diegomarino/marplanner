import { appUrl } from "@/lib/base-path";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { navigateHousehold } from "@/shell/routes";

export function PluginUnavailable(): React.JSX.Element {
  const t = useT();

  return (
    <section className="flex min-w-0 flex-col gap-3 p-6" data-testid="plugin-unavailable">
      <h1 className="text-xl font-semibold">{t("plugins.unavailable.title")}</h1>
      <p className="text-muted-foreground">{t("plugins.unavailable.description")}</p>
      <Button asChild variant="outline" className="w-fit">
        <a
          href={appUrl("/admin/plugins")}
          onClick={(event) => {
            event.preventDefault();
            navigateHousehold("/admin/plugins");
          }}
        >
          {t("plugins.unavailable.return")}
        </a>
      </Button>
    </section>
  );
}
