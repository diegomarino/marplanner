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

## Win Jingle

The chores board plays "Win Jingle" by Fupi when a child finishes a block of chores. It is
dedicated to the public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/),
so no attribution is required; it is credited here for provenance. The files live in
`src/client/chores/audio/`: `win-jingle.ogg` is the original `winfretless_0.ogg`, unmodified, and
`win-jingle.mp3` is a 96 kbps transcode of it (ffmpeg/libmp3lame) for browsers without Ogg Vorbis.
[Source](https://opengameart.org/content/win-jingle).

## Dependencies

`package-lock.json` records the installed versions and declared package licenses.
A lockfile declaration does not replace a dependency's required license text or
notices, so every build writes a `THIRD_PARTY_LICENSES.txt` beside each bundle
(`dist/server/`, `dist/daily-briefing-render/` and `dist/client/`, which the
container image copies and the client serves at `THIRD_PARTY_LICENSES.txt`). Each
lists the exact packages inlined into that bundle with their declared license and
the license and notice files they ship (`scripts/bundled-licenses.mjs`). A few
packages publish no license file; for an MIT or Apache-2.0 package the entry
carries that license's standard text (`scripts/licenses/`), with the MIT
copyright line naming the package's `package.json` author, and any other
license is recorded as declared, with the source repository. Packages loaded at
runtime from `node_modules` (native modules such as `better-sqlite3`, `argon2` and
`@resvg/resvg-js`) keep their own license files there. Native binaries remain platform-specific installation artifacts;
they are not committed to this source repository.

## Daily Briefing corpora derived from third-party data

The corpora in `src/server/modules/daily-briefing/corpora/` are part of this
project and licensed with it, except the five below, which derive from
third-party services and are bundled into the server build. Four were built by
import scripts in the predecessor
[Marplanner repository](https://github.com/diegomarino/marplanner); the fifth
translates one of them. Each keeps its source's terms.

**`trivia-questions.json` (832 questions).** Retrieved on 2026-06-12
([commit fe71295](https://github.com/diegomarino/marplanner/commit/fe7129584ad6daf3ef411299f047d1f965ca886e))
from the [Open Trivia Database](https://opentdb.com/) multiple-choice API
(categories 9, 17, 19, 21, 22, 23 and 27, three difficulties). Open Trivia Database
content is licensed under
[Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/).
Changes: HTML entities decoded, duplicate questions removed, answer options sorted,
reshaped to `{question, correctAnswer, options, difficulty, category}`. This file is
distributed under the same license; the notice travels with the build as
`dist/server/CORPORA-NOTICE.txt`.

**`vocabulary-entries.json` (398 entries).** A project word list enriched on
2026-06-12 (commit fe71295) through the [Free Dictionary API](https://dictionaryapi.dev/),
which serves definitions from [Wiktionary](https://en.wiktionary.org/) and labels them
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/); each entry's source is
`https://en.wiktionary.org/wiki/<word>`. Changes: one definition, example and
pronunciation kept per word, reshaped to
`{word, level, type, definition, example, pronunciation}`. This file is distributed under
the same license. (The API's own GPL-3.0 license covers its server code, not this data.)

**`number-facts.json` (366 entries).** Retrieved on 2026-06-12 (commit fe71295) from
`number-trivia.com` math and trivia responses; 18 numbers the service did not answer
use the script's own arithmetic sentences. `number-trivia.com` publishes no terms,
license or data source; its responses repeat the text of the retired Numbers API
(`numbersapi.com`), which did not publish a data license either.

**`number-facts.es.json` (366 entries).** A Spanish translation of `number-facts.json`
made for Marplanner and bundled for Spanish deployments; the same source and the
absence of published terms apply. Changes: each fact translated into Spanish, same
numbers and kinds.

**`word-search-corpus.json`.** Retrieved on 2026-06-10 (`generatedAt` in the file)
from the [Datamuse API](https://www.datamuse.com/api/), acknowledged here as its
documentation requests for public applications. The import requests
`sp=<letter>*&md=f&max=1000`, keeps lowercase alphabetic words of 3–10 letters and
builds frequency-ranked pools; Datamuse documents Google Books Ngrams as the source
of its frequency data. No definitions are included.

## Blonde ponytail icon

The chore catalog includes a blonde recoloring of the CC0 OpenClipart
[female avatar with ponytail](https://freesvg.org/female-avatar-with-pony-tail).
The original source attribution is retained in the SVG.
