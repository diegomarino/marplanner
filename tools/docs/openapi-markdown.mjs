// Render the committed OpenAPI document as a Markdown reference: an index, one file per tag and
// the shared component schemas. Pure: takes the parsed document, returns { relativePath: text }.

const METHODS = ["get", "post", "put", "patch", "delete"];

const cell = (value) =>
  String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n+/g, " ")
    .trim();
const refName = (ref) => ref.split("/").pop();
/** GitHub's heading anchor: lowercase, punctuation dropped, spaces become hyphens. */
export const headingAnchor = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");

export function renderOpenApiMarkdown(
  spec,
  { source = "docs/api/openapi.json", commit = "", preamble = "" } = {}
) {
  const schemas = spec.components?.schemas ?? {};
  // Links are written relative to the tag files; the index and schemas.md strip the "../".
  const schemaLink = (name) => `[${name}](../schemas.md#${headingAnchor(name)})`;

  function typeOf(schema) {
    if (!schema) return "any";
    if (schema.$ref) return schemaLink(refName(schema.$ref));
    if (schema.const !== undefined) return `\`${JSON.stringify(schema.const)}\``;
    if (schema.enum) return schema.enum.map((v) => `\`${JSON.stringify(v)}\``).join(" \\| ");
    for (const key of ["oneOf", "anyOf"])
      if (schema[key]) return schema[key].map(typeOf).join(" \\| ");
    if (schema.allOf) return schema.allOf.map(typeOf).join(" & ");
    let type = Array.isArray(schema.type) ? schema.type.join(" \\| ") : schema.type;
    if (type === "array" || schema.items) return `array<${typeOf(schema.items)}>`;
    if (!type && schema.properties) type = "object";
    if (schema.format) type += ` (${schema.format})`;
    if (schema.pattern) type += ` pattern \`${schema.pattern}\``;
    return type ?? "any";
  }

  function constraints(schema) {
    const notes = [];
    for (const [key, label] of [
      ["minimum", "min"],
      ["maximum", "max"],
      ["minLength", "minLen"],
      ["maxLength", "maxLen"],
      ["minItems", "minItems"],
      ["maxItems", "maxItems"],
    ])
      if (schema?.[key] !== undefined) notes.push(`${label} ${schema[key]}`);
    if (schema?.default !== undefined) notes.push(`default \`${JSON.stringify(schema.default)}\``);
    return notes.join(", ");
  }

  /** A field table for an object schema; a `$ref` is expanded one level when `expand` is set. */
  function fieldsTable(schema, expand = false) {
    if (!schema) return "";
    if (schema.$ref) {
      const target = schemas[refName(schema.$ref)];
      const line = `Schema: ${typeOf(schema)}\n`;
      return expand && target?.properties ? `${line}\n${fieldsTable(target)}` : line;
    }
    if (!schema.properties) return `Type: ${typeOf(schema)}\n`;
    const required = new Set(schema.required ?? []);
    let out = "| Field | Type | Required | Notes |\n| --- | --- | --- | --- |\n";
    for (const [name, field] of Object.entries(schema.properties)) {
      const notes = [field.description, constraints(field)].filter(Boolean).join(" · ");
      out += `| \`${name}\` | ${typeOf(field)} | ${required.has(name) ? "yes" : "no"} | ${cell(notes)} |\n`;
    }
    return out;
  }

  function operationSection(path, method, op, pathParameters = []) {
    let md = `### \`${method.toUpperCase()} ${path}\`\n\n`;
    if (op.summary) md += `**${op.summary.trim()}**\n\n`;
    if (op.deprecated) md += "> Deprecated.\n\n";
    if (op.description) md += `${op.description.trim()}\n\n`;
    const security = (op.security ?? spec.security ?? []).flatMap((entry) => Object.keys(entry));
    md += `- Operation ID: \`${op.operationId ?? "-"}\`\n`;
    md += `- Auth: ${security.length ? security.map((name) => `\`${name}\``).join(" or ") : "none"}\n\n`;

    const parameters = [...pathParameters, ...(op.parameters ?? [])];
    if (parameters.length) {
      md += "**Parameters**\n\n| Name | In | Type | Required | Description |\n";
      md += "| --- | --- | --- | --- | --- |\n";
      for (const p of parameters) {
        const notes = [p.description, constraints(p.schema)].filter(Boolean).join(" · ");
        md += `| \`${p.name}\` | ${p.in} | ${typeOf(p.schema)} | ${p.required ? "yes" : "no"} | ${cell(notes)} |\n`;
      }
      md += "\n";
    }

    if (op.requestBody) {
      md += `**Request body**${op.requestBody.required ? " (required)" : ""}\n\n`;
      for (const [contentType, media] of Object.entries(op.requestBody.content ?? {}))
        md += `Content type \`${contentType}\`\n\n${fieldsTable(media.schema, true)}\n`;
    }

    const responses = Object.entries(op.responses ?? {});
    md += "**Responses**\n\n| Status | Description | Body |\n| --- | --- | --- |\n";
    for (const [status, response] of responses) {
      const body = response.content
        ? Object.values(response.content)
            .map((media) => (media.schema?.properties ? "object" : typeOf(media.schema)))
            .join(", ")
        : "-";
      md += `| ${status} | ${cell(response.description)} | ${body} |\n`;
    }
    const success = responses.find(
      ([status, response]) => status.startsWith("2") && response.content
    );
    const successSchema = success && Object.values(success[1].content)[0].schema;
    const successTarget = successSchema?.$ref
      ? schemas[refName(successSchema.$ref)]
      : successSchema;
    if (successTarget?.properties)
      md += `\n**${success[0]} body**\n\n${fieldsTable(successSchema, true)}`;
    return `${md}\n---\n\n`;
  }

  const tags = spec.tags ?? [];
  const byTag = new Map(tags.map((tag) => [tag.name, []]));
  for (const [path, item] of Object.entries(spec.paths ?? {}))
    for (const method of METHODS)
      if (item[method]) {
        const tag = item[method].tags?.[0] ?? "other";
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag).push({ path, method, op: item[method], pathParameters: item.parameters });
      }

  const files = {};
  const toRoot = (text) => text.replaceAll("](../schemas.md#", "](schemas.md#");
  let operations = 0;
  let domains = "| Domain | Operations | Description |\n| --- | --- | --- |\n";
  let all = "| Method | Path | Domain | Summary |\n| --- | --- | --- | --- |\n";
  for (const [tag, entries] of byTag) {
    if (!entries.length) continue;
    operations += entries.length;
    const description = (tags.find((t) => t.name === tag)?.description ?? "").trim();
    // Tag descriptions open with a bold title line; the index shows the sentence after it.
    const blurb = cell(description.replace(/^\*\*[^*]+\*\*/, "")).slice(0, 200);
    domains += `| [${tag}](endpoints/${tag}.md) | ${entries.length} | ${blurb} |\n`;
    let md = `# ${tag}\n\n${description}\n\n| Method | Path | Summary |\n| --- | --- | --- |\n`;
    for (const { path, method, op } of entries) {
      md += `| ${method.toUpperCase()} | [\`${path}\`](#${headingAnchor(`${method} ${path}`)}) | ${cell(op.summary)} |\n`;
      all += `| ${method.toUpperCase()} | \`${path}\` | [${tag}](endpoints/${tag}.md) | ${cell(op.summary)} |\n`;
    }
    md += "\n";
    for (const { path, method, op, pathParameters } of entries)
      md += operationSection(path, method, op, pathParameters);
    files[`endpoints/${tag}.md`] = md;
  }

  let index = `# ${spec.info.title} ${spec.info.version}\n\n`;
  const at = commit ? ` at commit \`${commit}\`` : "";
  index += `Generated from \`${source}\`${at} (OpenAPI ${spec.openapi}). Do not edit by hand.\n\n`;
  if (preamble) index += `${preamble.trim()}\n\n`;
  if (spec.info.description) index += `${spec.info.description.trim()}\n\n`;
  index += "## Authentication\n\n";
  for (const [name, scheme] of Object.entries(spec.components?.securitySchemes ?? {})) {
    const where = scheme.in
      ? `, ${scheme.in} \`${scheme.name}\``
      : scheme.scheme
        ? `, ${scheme.scheme}`
        : "";
    index += `- **\`${name}\`** (${scheme.type}${where}): ${cell(scheme.description)}\n`;
  }
  index += `\n## Domains\n\n${domains}\n`;
  index += `${operations} operations on ${Object.keys(spec.paths ?? {}).length} paths. `;
  index += `Shared schemas: [schemas.md](schemas.md).\n\n## All endpoints\n\n${all}`;
  files["README.md"] = index;

  let schemasMd = `# Schemas\n\n${Object.keys(schemas).length} shared component schemas.\n\n`;
  for (const [name, schema] of Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))) {
    schemasMd += `## ${name}\n\n${schema.description ? `${schema.description.trim()}\n\n` : ""}`;
    schemasMd += `${fieldsTable(schema)}\n`;
  }
  files["schemas.md"] = toRoot(schemasMd);
  return files;
}
