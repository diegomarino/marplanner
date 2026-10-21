# Third-party notices

Marplanner's own source is licensed under the [MIT License](LICENSE). Dependencies
and bundled assets retain their own licenses.

## JetBrains Mono

The briefing renderer bundles Regular, Medium, Bold and ExtraBold TTF files from
JetBrains Mono. Copyright 2020 The JetBrains Mono Project Authors. The font is
licensed under the SIL Open Font License 1.1; the complete [license and notice](src/server/modules/daily-briefing/render/fonts/jetbrains-mono/OFL.txt)
is included next to the fonts and copied into both render distributions.
[Upstream project](https://github.com/JetBrains/JetBrainsMono).

## Weather Icons

The weather pill and forecast dialog draw their condition icons from path data taken
from Weather Icons by Erik Flowers. The icons are licensed under the SIL Open Font
License 1.1; the complete [license and notice](src/client/home/weather-icons/OFL.txt)
is included next to the vendored path data.
[Upstream project](https://github.com/erikflowers/weather-icons).

## Dependencies

`package-lock.json` records the installed versions and declared package licenses.
A lockfile declaration does not replace a dependency's required license text or
notices, so every build writes a `THIRD_PARTY_LICENSES.txt` beside each bundle
(`dist/server/`, `dist/daily-briefing-render/` and `dist/client/`, which the
container image copies and the client serves at `THIRD_PARTY_LICENSES.txt`). Each
lists the exact packages inlined into that bundle with their declared license and
the license and notice files they ship (`scripts/bundled-licenses.mjs`). A few
packages publish no license file; their entry records the declared license and
source repository. Packages loaded at runtime from `node_modules` (native modules
such as `better-sqlite3`, `argon2` and `@resvg/resvg-js`) keep their own license
files there. Native binaries remain platform-specific installation artifacts;
they are not committed to this source repository.

## Bundled briefing content — publication blocker

The corpus files live in `src/server/modules/daily-briefing/corpora/`. They are
content assets, not covered by a blanket claim under the application's MIT
license. Repository lineage was checked on 2026-10-07 against predecessor
[Marplanner commit f4c1c46](https://github.com/diegomarino/marplanner/tree/f4c1c46a316e131fc273541dc2fd715ef0331bd8/apps/api/src/lib/daily-briefing/corpora).
All English files and the word-search file match that snapshot byte for byte.
Spanish animal facts, number facts and would-you-rather prompts match as parsed
JSON; Spanish drawing prompts differ by one repaired truncated entry. This
establishes import lineage, not authorship or redistribution clearance.
The maintainer recalls that many corpora were generated with LLM agents, but
cannot identify which files or provide generation records. This recollection is
not treated as an item-level provenance or permission receipt.

| Files (entries per language)                                     | Recorded source                                                                                                                                                                                                                                                                                      | Remaining evidence                                                                                                                                                                          |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `animal-facts.json`, `animal-facts.es.json` (484 each)           | [Predecessor pool commit](https://github.com/diegomarino/marplanner/commit/ef6f3e1113e49528831770202526fcab06aab848) describes paraphrasing credible sources; it replaced cat/dog API fetching.                                                                                                      | Original source references, authorship and permissions for the curated text and translation. The old APIs are not established as the source of this pool.                                   |
| `drawing-prompts.json`, `drawing-prompts.es.json` (365 each)     | [Predecessor expansion](https://github.com/diegomarino/marplanner/commit/aea7256defeeb98c565ae4c118b2e3e16937e35a) records a subagent audit and 264 additions.                                                                                                                                       | Origin of the initial pool and generation/translation records; the commit alone does not establish rights for every entry.                                                                  |
| `jokes.json` (588)                                               | [Predecessor pool commit](https://github.com/diegomarino/marplanner/commit/2ed28760d4122e2873c422ba3aa24e2b24d87913) records a curated replacement for live icanhazdadjoke retrieval.                                                                                                                | Sources and permissions for the curated pool; replacement history does not prove that the entries came from that API.                                                                       |
| `number-facts.json`, `number-facts.es.json` (366 each)           | [Refresh script](https://github.com/diegomarino/marplanner/blob/90b38ab3478a0c1915c59f84d64a40dcfb4e60d1/apps/api/src/db/seeds/daily-print/refresh-number-facts.ts) used `number-trivia.com` math/trivia responses with local arithmetic fallbacks.                                                  | Retrieval receipts identifying API-derived versus fallback entries, source permissions and Spanish translation records.                                                                     |
| `riddles.json` (122)                                             | [Predecessor expansion](https://github.com/diegomarino/marplanner/commit/af631a8404f3f8a3b9e28434a5ca89eeb8a02742) records 61 additions to the original pool.                                                                                                                                        | Authorship/source and permissions for both portions.                                                                                                                                        |
| `trivia-questions.json` (832)                                    | [Refresh script](https://github.com/diegomarino/marplanner/blob/90b38ab3478a0c1915c59f84d64a40dcfb4e60d1/apps/api/src/db/seeds/daily-print/refresh-trivia.ts) retrieves Open Trivia Database multiple-choice questions, decodes entities, deduplicates questions and sorts options.                  | Confirm the snapshot against retrieval records and carry the applicable attribution, change notice and share-alike license with redistributed data.                                         |
| `vocabulary-entries.json` (398)                                  | [Refresh script](https://github.com/diegomarino/marplanner/blob/90b38ab3478a0c1915c59f84d64a40dcfb4e60d1/apps/api/src/db/seeds/daily-print/refresh-vocabulary.ts) enriches a local word list with Free Dictionary API definitions, examples and pronunciation.                                       | Recover source/license information for the exact retained entries; the script did not preserve response license/source fields. API software licensing does not establish content licensing. |
| `would-you-rathers.json`, `would-you-rathers.es.json` (201 each) | [Predecessor expansion](https://github.com/diegomarino/marplanner/commit/49dbbad42885e5f5b253da63a37698548e8b68fe) records expansion from 50 to 201 prompts.                                                                                                                                         | Authorship/source and permissions for the initial pool, additions and translation.                                                                                                          |
| `word-search-corpus.json`                                        | Embedded metadata records Datamuse retrieval on `2026-06-10T13:54:51.202Z`; the [download script](https://github.com/diegomarino/marplanner/blob/f4c1c46a316e131fc273541dc2fd715ef0331bd8/apps/api/scripts/download-word-search-corpus.mjs) filters, deduplicates and partitions words by frequency. | Confirm redistribution terms for the retained word/frequency dataset and its upstream data; API access alone is not a blanket data license.                                                 |

### Known upstream notices

Trivia source: [Open Trivia Database](https://opentdb.com/api_config.php), which
licenses API data under [Creative Commons Attribution-ShareAlike 4.0
International](https://creativecommons.org/licenses/by-sa/4.0/). The recorded
import performs the transformations listed above. This notice identifies the
known source; it does not claim that missing snapshot receipts have been recovered.

Word-search source: [Datamuse API](https://www.datamuse.com/api/), acknowledged here
as requested by its documentation for public applications. The import requests
`sp=<letter>*&md=f&max=1000`, retains lowercase alphabetic words of length 3–10,
and builds frequency-ranked pools. Datamuse documents Google Books Ngrams as the
source of frequency metadata. The corpus does not request definitions.

Vocabulary retrieval service: [Free Dictionary API](https://dictionaryapi.dev/).
A current response or the API's software license cannot retroactively establish
the source and terms of a previously flattened definition.

The local product preserves these implemented assets. Public redistribution
remains blocked until the outstanding source, permission and attribution records
above are verified, and complete notices for bundled dependencies are assembled.
Do not infer clearance from import history or the application's source license.

## Blonde ponytail icon

The chore catalog includes a blonde recoloring of the CC0 OpenClipart
[female avatar with ponytail](https://freesvg.org/female-avatar-with-pony-tail).
The original source attribution is retained in the SVG.
