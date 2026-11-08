#!/usr/bin/env node
// Build the public landing page (GitHub Pages) from site/ plus generated parts.
//
//   npm run docs:site      write dist/site/
//
// Nothing generated is committed. The build copies site/ as is, then adds:
// - images/: the screenshots index.html references, from docs/images/features/
// - favicon.svg: the app's own icon, from public/
// - openapi.json and api/: the committed OpenAPI document, its `servers` pointed at the
//   reader's own instance (publishedSpec), and the same Scalar viewer `/api/docs` serves
//   (read-only, document inline), via tools/docs/api-bundle.mjs
// - downloads/marplanner-api-docs.zip: the offline API bundle (`npm run docs:api-bundle`)
// - the API domain cards, one per OpenAPI tag, in place of the `<!-- @api-tags -->` marker
// So the published reference never drifts from docs/api/openapi.json, which
// `npm run check:openapi` keeps in step with the routes.

import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildApiBundle, scalarBundle, viewerHtml } from "./api-bundle.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Display copy for each OpenAPI tag. Every tag in the document needs an entry: a new tag fails
 * the build until it gets one, so the landing page never shows a half-labelled domain. */
export const TAG_CARDS = {
  bootstrap: {
    label: "Foundation",
    blurb: "Health, access gate, device provisioning, PIN and household.",
  },
  settings: { label: "Settings", blurb: "The effective settings, core locale included." },
  members: { label: "Members", blurb: "Create, edit, archive and restore household members." },
  "day-periods": {
    label: "Day periods",
    blurb: "Morning, afternoon, evening and night, with their start times.",
  },
  chores: {
    label: "Routines & chores",
    blurb: "Routines, assignments, dated completions and the chores board.",
  },
  calendar: {
    label: "Calendar",
    blurb: "Local and ICS events, recurrence, assignment and highlight rules.",
  },
  meals: {
    label: "Meals & recipes",
    blurb: "Recipes, meal types, weekly plans and one-off meals.",
  },
  reminders: { label: "Reminders", blurb: "Scheduled reminders, assignments and live emissions." },
  "daily-messages": { label: "Daily messages", blurb: "A message for each member, each day." },
  "daily-briefing": {
    label: "Daily briefing",
    blurb: "Block configuration, generation, preview and printing.",
  },
  "time-announcements": {
    label: "Time announcements",
    blurb: "Rules for when the tablet says the time.",
  },
  weather: { label: "Weather", blurb: "Household location and the forecast." },
  printing: {
    label: "Printing",
    blurb: "Durable print jobs, printer capabilities, claims and receipts.",
  },
  "network-devices": {
    label: "Network devices",
    blurb: "Registered devices, live inventory and block state.",
  },
  backups: { label: "Backups", blurb: "Snapshots, download, upload and restore." },
  telemetry: { label: "Telemetry", blurb: "Client log ingest and the admin view." },
  plugins: { label: "Plugins", blurb: "The plugin catalogue and lifecycle." },
  docs: { label: "API docs", blurb: "This OpenAPI document and its interactive reference." },
};

const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]
  );

/** Operations per tag, in the document's tag order. */
export function apiDomains(spec) {
  const counts = new Map();
  for (const item of Object.values(spec.paths ?? {})) {
    for (const operation of Object.values(item)) {
      for (const tag of operation?.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return (spec.tags ?? []).map(({ name }) => {
    const card = TAG_CARDS[name];
    if (!card)
      throw new Error(
        `site: OpenAPI tag "${name}" has no entry in TAG_CARDS (tools/docs/site.mjs)`
      );
    return { name, ...card, operations: counts.get(name) ?? 0 };
  });
}

/** index.html with the API markers replaced by generated markup. */
export function renderIndex(html, spec) {
  const domains = apiDomains(spec);
  const total = domains.reduce((sum, domain) => sum + domain.operations, 0);
  const cards = domains
    .map(
      ({ name, label, blurb, operations }) =>
        `<li><a href="api/#tag/${encodeURIComponent(name)}">` +
        `<span class="api-domain-head"><span>${escapeHtml(label)}</span>` +
        `<span class="api-domain-count">${operations} ${operations === 1 ? "op" : "ops"}</span></span>` +
        `<span class="api-domain-blurb">${escapeHtml(blurb)}</span></a></li>`
    )
    .join("\n            ");
  const summary = `${total} operations in ${domains.length} domains`;
  for (const marker of ["<!-- @api-tags -->", "<!-- @api-summary -->"]) {
    if (!html.includes(marker)) throw new Error(`site: site/index.html lost its ${marker} marker`);
  }
  return html.replace("<!-- @api-tags -->", cards).replace("<!-- @api-summary -->", summary);
}

/** The document as the public reference shows it. Its `servers` entry is `/`, right on an
 * instance but wrong on GitHub Pages, where examples would point at the Pages host. The site
 * offers an editable base URL instead, defaulting to a local install. */
export function publishedSpec(spec) {
  return {
    ...spec,
    servers: [
      {
        url: "{base}",
        description: "Your Marplanner instance",
        variables: { base: { default: "http://localhost:3000" } },
      },
    ],
  };
}

/** Local `images/<name>` references in the page, each backed by docs/images/features/<name>. */
export function referencedImages(html) {
  return [
    ...new Set(
      [...html.matchAll(/\b(?:src|content)="images\/([^"/]+)"/g)].map((match) => match[1])
    ),
  ];
}

export async function buildSite({ root = ROOT, outDir = join(root, "dist/site") } = {}) {
  const spec = JSON.parse(readFileSync(join(root, "docs/api/openapi.json"), "utf8"));
  rmSync(outDir, { recursive: true, force: true });
  cpSync(join(root, "site"), outDir, { recursive: true });

  const indexPath = join(outDir, "index.html");
  const html = renderIndex(readFileSync(indexPath, "utf8"), spec);
  writeFileSync(indexPath, html);

  const images = referencedImages(html);
  mkdirSync(join(outDir, "images"), { recursive: true });
  for (const image of images) {
    copyFileSync(join(root, "docs/images/features", image), join(outDir, "images", image));
  }
  copyFileSync(join(root, "public/favicon.svg"), join(outDir, "favicon.svg"));
  const published = publishedSpec(spec);
  writeFileSync(join(outDir, "openapi.json"), `${JSON.stringify(published, null, 2)}\n`);

  mkdirSync(join(outDir, "api/js"), { recursive: true });
  writeFileSync(join(outDir, "api/index.html"), viewerHtml(published));
  writeFileSync(join(outDir, "api/js/scalar.js"), await scalarBundle());

  const scratch = mkdtempSync(join(tmpdir(), "marplanner-site-"));
  try {
    const { zipPath } = await buildApiBundle({ root, outDir: scratch });
    mkdirSync(join(outDir, "downloads"), { recursive: true });
    copyFileSync(zipPath, join(outDir, "downloads/marplanner-api-docs.zip"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  // GitHub Pages: serve files as they are, without Jekyll.
  writeFileSync(join(outDir, ".nojekyll"), "");
  return { outDir, images };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { outDir, images } = await buildSite();
  console.log(`Landing page → ${relative(process.cwd(), outDir)} (${images.length} screenshots)`);
}
