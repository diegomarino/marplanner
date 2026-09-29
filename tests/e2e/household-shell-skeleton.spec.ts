import { expect, test } from "@playwright/test";

test("household shell: all family routes, removed briefing, history and locked admin entry", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page
    .getByTestId("access-gate-form")
    .locator('input[name="token"]')
    .fill(process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token");
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await page
    .getByLabel("Bootstrap key")
    .fill(process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key");
  await page.getByRole("button", { name: "Provision Device" }).click();
  await expect(page.getByTestId("home-surface")).toBeVisible();

  const nav = page.getByRole("navigation");
  await expect(nav.getByRole("link")).toHaveCount(4);
  await page.screenshot({ path: testInfo.outputPath("household-home.png"), fullPage: true });
  // A browser-local marker disappears on document reload; navigation must retain the app.
  await page.evaluate(() => document.documentElement.setAttribute("data-shell-probe", "mounted"));
  await nav.locator('a[href="/calendar"]').click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.getByRole("heading", { name: /^(Calendar|Calendario)$/ })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-shell-probe", "mounted");
  await page.goBack();
  await expect(page.getByTestId("home-surface")).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: /^(Calendar|Calendario)$/ })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-shell-probe", "mounted");

  for (const destination of [
    {
      href: "/chores",
      target: page.getByRole("heading", {
        name: /^(Daily Chores Board|Tablero de Tareas Diarias)$/,
      }),
    },
    { href: "/meals", target: page.getByTestId("meals-board") },
    { href: "/", target: page.getByTestId("home-surface") },
  ]) {
    await nav.locator(`a[href="${destination.href}"]`).click();
    await expect(page).toHaveURL(
      destination.href === "/" ? /\/$/ : new RegExp(`${destination.href}$`)
    );
    await expect(destination.target).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-shell-probe", "mounted");
  }

  await page.goto("/daily-briefing");
  await expect(page).toHaveURL(/\/daily-briefing$/);
  await expect(
    page.getByRole("heading", { name: /^(Page not found|Página no encontrada)$/ })
  ).toBeVisible();
  await expect(page.getByTestId("home-surface")).toHaveCount(0);
  await expect(page.getByText(/daily briefing/i)).toHaveCount(0);

  await page.goto("/admin/printing");
  await expect(page.getByTestId("admin-pin-keypad")).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/printing$/);
  await expect(page.getByTestId("admin-panel-scope")).toHaveCount(0);
  await expect(page.getByTestId("printing-management")).toHaveCount(0);
  await expect(page.getByTestId("home-surface")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("household-admin-locked.png"),
    fullPage: true,
  });

  // Browser capability evidence only. owns the product presentation-mode listener.
  // The probe records actual media events and never synthesizes a PWA transition.
  const observation = page.evaluate(async () => {
    const media = ["standalone", "fullscreen"].map((mode) => ({
      mode,
      query: matchMedia(`(display-mode: ${mode})`),
    }));
    const evidence = {
      userAgent: navigator.userAgent,
      fullscreenEnabled: document.fullscreenEnabled,
      requestFullscreen: typeof document.documentElement.requestFullscreen === "function",
      fullscreenChangeSupported: "onfullscreenchange" in document,
      fullscreenEvents: [] as string[],
      media: media.map(({ mode, query }) => ({
        mode,
        initial: query.matches,
        changeListenerSupported: typeof query.addEventListener === "function",
      })),
      mediaEvents: [] as { mode: string; matches: boolean }[],
      error: null as string | null,
    };
    const onFullscreen = () =>
      evidence.fullscreenEvents.push(document.fullscreenElement ? "entered" : "exited");
    const listeners = media.map(({ mode, query }) => {
      const listener = (event: MediaQueryListEvent) =>
        evidence.mediaEvents.push({ mode, matches: event.matches });
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    });
    document.addEventListener("fullscreenchange", onFullscreen);
    // Real click activation: the button is probe UI only and is removed after the observation.
    const button = document.createElement("button");
    button.textContent = "Run fullscreen probe";
    button.id = "fullscreen-probe";
    document.body.append(button);
    const result = new Promise<typeof evidence>((resolve) => {
      button.onclick = async () => {
        const transition = async (action: () => Promise<void>) => {
          let listener: () => void = () => {};
          let timer: ReturnType<typeof setTimeout>;
          const event = new Promise<void>((done, reject) => {
            listener = done;
            document.addEventListener("fullscreenchange", listener, { once: true });
            timer = setTimeout(() => reject(new Error("fullscreenchange timed out")), 3000);
          });
          try {
            await Promise.all([event, action()]);
          } finally {
            clearTimeout(timer!);
            document.removeEventListener("fullscreenchange", listener);
          }
        };
        try {
          await transition(() => document.documentElement.requestFullscreen());
          await transition(() => document.exitFullscreen());
        } catch (error) {
          evidence.error = String(error);
        } finally {
          document.removeEventListener("fullscreenchange", onFullscreen);
          listeners.forEach((remove) => remove());
          button.remove();
          resolve(evidence);
        }
      };
    });
    return await result;
  });
  await page.locator("#fullscreen-probe").click();
  const evidence = await observation;
  await testInfo.attach("presentation-mode-probe", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });
  console.log("Presentation-mode probe:", JSON.stringify(evidence));
  expect(evidence.error).toBeNull();
  expect(evidence.fullscreenEvents).toEqual(["entered", "exited"]);
  expect(
    evidence.media.every(
      (entry: { changeListenerSupported: boolean }) => entry.changeListenerSupported
    )
  ).toBe(true);
});
