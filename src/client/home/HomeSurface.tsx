import { Component, type ReactNode } from "react";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useTranslation } from "@/i18n";
import { PluginContribution } from "@/plugins/contributions";
import { TodayAgenda } from "./TodayAgenda";
import { TodayChores } from "./TodayChores";
import { TodayMeals } from "./TodayMeals";

/** Landscape-first kitchen dashboard: agenda at left, chores dominant at right, meals below. */
export function HomeSurface(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <main
      data-testid="home-surface"
      className="min-h-0 p-4 lg:h-[calc(100dvh-4rem)] lg:overflow-hidden"
    >
      <h1 className="sr-only">Marplanner</h1>
      <div
        data-testid="home-dashboard-grid"
        // One shrinkable column below `lg`: an implicit `auto` column would grow to its widest row
        // and push the page sideways on a narrow screen.
        className="grid grid-cols-1 gap-4 lg:h-full lg:min-h-0 lg:grid-cols-[minmax(16rem,25%)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)_auto]"
      >
        <div
          data-testid="home-agenda-region"
          className="min-h-0 min-w-0 lg:row-span-2 lg:overflow-hidden"
        >
          <HomeWidgetBoundary title={t("agenda.title")} errorMessage={t("home.widgetError")}>
            <TodayAgenda />
          </HomeWidgetBoundary>
        </div>
        <div
          data-testid="home-chores-region"
          className="min-h-0 lg:col-start-2 lg:row-start-1 lg:overflow-hidden"
        >
          <HomeWidgetBoundary title={t("todayChores.title")} errorMessage={t("home.widgetError")}>
            <TodayChores />
          </HomeWidgetBoundary>
        </div>
        <PluginContribution pluginId="meals-recipes" group="widgets" contributionId="today-meals">
          <div
            data-testid="home-meals-region"
            className="min-h-0 lg:col-start-2 lg:row-start-2 lg:overflow-hidden"
          >
            <HomeWidgetBoundary title={t("todayMeals.title")} errorMessage={t("home.widgetError")}>
              <TodayMeals />
            </HomeWidgetBoundary>
          </div>
        </PluginContribution>
      </div>
    </main>
  );
}

class HomeWidgetBoundary extends Component<
  { title: string; errorMessage: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <section className="bg-card rounded-lg border p-4">
          <h2 className="mb-3 text-xl font-semibold">{this.props.title}</h2>
          <ErrorNotice message={this.props.errorMessage} />
        </section>
      );
    }
    return this.props.children;
  }
}
