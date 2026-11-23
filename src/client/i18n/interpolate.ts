/** Fill the `{name}` placeholders of a message in one pass, taking every value literally.
 * `String.prototype.replace` with a replacement string expands `$$`, `$&`, `` $` `` and `$'`,
 * and chained calls scan again the text an earlier call inserted; both corrupt a household
 * name. A placeholder without a value stays as written.
 */
export function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
  );
}
