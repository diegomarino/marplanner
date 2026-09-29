# Third-party notices

Marplanner's own source is licensed under the [MIT License](LICENSE). Dependencies
and bundled assets retain their own licenses.

## JetBrains Mono

The briefing renderer bundles Regular, Medium, Bold and ExtraBold TTF files from
JetBrains Mono. Copyright 2020 The JetBrains Mono Project Authors. The font is
licensed under the SIL Open Font License 1.1; the complete [license and notice](src/server/modules/daily-briefing/render/fonts/jetbrains-mono/OFL.txt)
is included next to the fonts and copied into both render distributions.
[Upstream project](https://github.com/JetBrains/JetBrainsMono).

## Dependencies

`package-lock.json` records the installed versions and declared package licenses.
A lockfile declaration does not replace a dependency's required license text or
notices. Distributions that bundle dependency code must carry the applicable
notices from those exact packages. Native binaries remain platform-specific
installation artifacts; they are not committed to this source repository.

## Bundled briefing content — publication blocker

The renderer includes animal facts, jokes, drawing prompts, vocabulary, riddles,
trivia, word-search words, and would-you-rather prompts. The word-search corpus
identifies a Datamuse API retrieval; the other content does not provide complete
item-level provenance and redistribution permissions. No blanket MIT licensing
claim is made for these data files.

The local product preserves these implemented assets. Public redistribution is
blocked until their source, permissions and required attribution are verified,
and complete notices for bundled dependencies are assembled. Do not publish the
corpora or infer clearance from the application's source license.
