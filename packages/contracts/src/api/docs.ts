/**
 * P1-06 (ADR-107): the API docs, generated from the route table —
 * docs/api/local-api.md (people) and docs/api/openapi.json (tools).
 * scripts/gen-api-docs.ts writes them; a test fails when they differ.
 *
 * P6-23a (ADR-159 §7): every word comes from the language packs — the
 * page's own text is `docs.api.*`, a route's is `api.route.<id>.*`, a
 * field's its `.describe()` key — in the translator's language. The
 * committed docs are English (`API_DOC_LANG`).
 */
import type { AnyRoute, ApiGroup, RouteTextSource } from "./route.ts";
import { documentedBody, exemptText, groupTitle, literalPath, localizeSchema, routeText } from "./route.ts";
import { LET_IN } from "./let-in.ts";
import { cliCommandOf, cliCommands, cliExemptions, cliHelp, fieldText } from "./cli.ts";
import { inputJsonSchema, limitsText, objectFields } from "./schema-info.ts";

const cell = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ");
const code = (s: string) => "`" + s.replace(/`/g, "'") + "`";
const anchor = (id: string) => id.replace(/\./g, "-").toLowerCase();

function accessText(r: AnyRoute, t: RouteTextSource) {
  const scope = r.scope ? code(r.scope) : t.dynamic("docs.api.access.noToken");
  const auth = r.auth ? t.dynamic(`docs.api.auth.${r.auth}`) : "";
  const channel = (c: string) => t.dynamic(`docs.api.channel.${c}`);
  const list = (xs: string[]) => xs.join(t.dynamic("docs.api.list"));
  return {
    scope: r.auth ? (r.scope ? t.dynamic("docs.api.access.scopeAuth", { scope, auth }) : auth) : scope,
    pin: !r.pin
      ? "—"
      : r.pinOn
        ? t.dynamic("docs.api.access.pinOn", { channels: list(r.pinOn.map(channel)) })
        : t.dynamic("docs.api.access.pinYes"),
    // P4-04: the A2A entry — visitors only, none of the owner's channels.
    channels: r.visitors
      ? t.dynamic("docs.api.access.visitorsOnly")
      : list(
          r.channels.map((c) =>
            c === "ai" && r.aiSelf ? t.dynamic("docs.api.channel.aiSelf", { param: code(":" + r.aiSelf) }) : channel(c),
          ),
        ),
  };
}

function fieldTable(title: string, schema: AnyRoute["body"], t: RouteTextSource): string[] {
  if (!schema) return [];
  const fields = objectFields(schema);
  if (fields === null)
    return [
      t.dynamic("docs.api.fields.notObject", { title }),
      "",
      "```json",
      JSON.stringify(localizeSchema(inputJsonSchema(schema), t), null, 2),
      "```",
      "",
    ];
  if (!fields.length) return [];
  const js = inputJsonSchema(schema);
  const union = !!(js.anyOf || js.oneOf);
  return [
    `**${title}**${union ? t.dynamic("docs.api.fields.union") : ""}`,
    "",
    t.dynamic("docs.api.fields.header"),
    "| --- | --- | --- | --- | --- |",
    ...fields.map(
      (f) =>
        `| ${code(f.name)} | ${cell(f.type)} | ${f.required ? t.dynamic("docs.api.fields.yes") : ""} | ${cell(limitsText(f.limits, t))} | ${cell(
          [
            f.input === "secret" ? t.dynamic("docs.api.fields.secret") : "",
            f.input === "file" ? t.dynamic("docs.api.fields.file") : "",
            fieldText(f, t),
          ].join(""),
        )} |`,
    ),
    "",
    ...(union
      ? [
          "<details><summary>JSON Schema</summary>",
          "",
          "```json",
          JSON.stringify(localizeSchema(js, t), null, 2),
          "```",
          "",
          "</details>",
          "",
        ]
      : []),
  ];
}

function routeSection(r: AnyRoute, t: RouteTextSource): string[] {
  const a = accessText(r, t);
  const c = cliCommandOf(r);
  const out = [
    `### ${r.id}`,
    "",
    `${code(`${r.method} ${literalPath(r.path)}`)} — ${routeText(r.id, "summary", t)}`,
    "",
  ];
  const description = routeText(r.id, "description", t);
  if (description) out.push(description, "");
  out.push(
    t.dynamic("docs.api.route.header"),
    "| --- | --- | --- | --- | --- |",
    `| ${a.scope} | ${a.pin} | ${a.channels} | ${r.idempotencyKey ? code(r.idempotencyKey) : "—"} | ${
      c
        ? code(
            ["daisy", ...c.path, ...c.args.map((x) => `<${x.name}>`)].join(" "),
          )
        : t.dynamic("docs.api.route.noCommand", { why: cell(exemptText(r, t) ?? "") })
    } |`,
    "",
  );
  if (r.removal)
    out.push(t.dynamic("docs.api.route.removal", { by: r.removal.by, why: routeText(r.id, "removal", t) ?? "" }), "");
  if (r.audit !== (r.method !== "GET")) {
    const why = routeText(r.id, "auditWhy", t);
    out.push(
      r.audit
        ? t.dynamic("docs.api.route.auditReads")
        : t.dynamic("docs.api.route.auditOff", { why: why ? t.dynamic("docs.api.route.auditWhy", { why }) : "" }),
      "",
    );
  }
  if (r.letsIn) {
    const k = LET_IN[r.letsIn];
    const back = k.revokes ? t.dynamic("docs.api.route.revokes", { what: t.dynamic(`api.revocation.${k.revokes}`) }) : "";
    out.push(t.dynamic("docs.api.route.letsIn", { row: t.dynamic(`api.letIn.${r.letsIn}`), revokes: back }), "");
  } else if (r.notLetIn) out.push(t.dynamic("docs.api.route.notLetIn", { why: routeText(r.id, "notLetIn", t) ?? "" }), "");
  if (r.external)
    out.push(t.dynamic("docs.api.route.external", { gate: t.dynamic(`docs.api.gate.${r.external}`) }), "");
  out.push(
    ...fieldTable(t.dynamic("docs.api.fields.params"), r.params, t),
    ...fieldTable(t.dynamic("docs.api.fields.query"), r.query, t),
    ...fieldTable(t.dynamic("docs.api.fields.body"), documentedBody(r), t),
  );
  out.push(t.dynamic("docs.api.route.answer", { kind: t.dynamic(`docs.api.output.${r.output.kind}`), name: code(outputName(r, t)) }), "");
  if (r.errors?.length)
    out.push(t.dynamic("docs.api.route.errors", { codes: r.errors.map(code).join(t.dynamic("docs.api.list")) }), "");
  return out;
}

const c0 = (r: AnyRoute) => ("command" in r.cli ? r.cli.command : undefined);

/** How the docs name an answer: a contracts type, or a pack key's text (`json("api.output.…")`). */
const outputName = (r: AnyRoute, t: RouteTextSource) => (t.has(r.output.name) ? t.dynamic(r.output.name) : r.output.name);

export interface DocsInput {
  routes: readonly AnyRoute[];
  groups: readonly { id: ApiGroup }[];
  apiVersion: number;
  /** The language the docs are written in. */
  t: RouteTextSource;
}

/** docs/api/local-api.md */
export function apiMarkdown({ routes, groups, apiVersion, t }: DocsInput): string {
  const commands = cliCommands(routes);
  const exempted = cliExemptions(routes);
  const out: string[] = [
    `# ${t.dynamic("docs.api.title")}`,
    "",
    t.dynamic("docs.api.generated"),
    "",
    t.dynamic("docs.api.counts", { version: apiVersion, routes: routes.length, commands: commands.length, exempt: exempted.length }),
    "",
    t.dynamic("docs.api.intro"),
    "",
    `## ${t.dynamic("docs.api.toc")}`,
    "",
  ];
  const cliTitle = t.dynamic("docs.api.cli.title");
  const exemptTitle = t.dynamic("docs.api.exempt.title");
  const headingAnchor = (h: string) => h.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");
  for (const g of groups) {
    const rs = routes.filter((r) => r.group === g.id);
    if (!rs.length) continue;
    out.push(`- [${groupTitle(g.id, t)}](#${anchor("g-" + g.id)})${t.dynamic("docs.api.toc.count", { count: rs.length })}`);
  }
  out.push(`- [${cliTitle}](#${headingAnchor(cliTitle)})`, `- [${exemptTitle}](#${headingAnchor(exemptTitle)})`, "");
  for (const g of groups) {
    const rs = routes.filter((r) => r.group === g.id);
    if (!rs.length) continue;
    out.push(
      `<a id="${anchor("g-" + g.id)}"></a>`,
      "",
      `## ${groupTitle(g.id, t)}`,
      "",
      t.dynamic("docs.api.group.header"),
      "| --- | --- | --- | --- | --- |",
      ...rs.map(
        (r) =>
          `| [${r.id}](#${anchor(r.id)}) | ${code(`${r.method} ${literalPath(r.path)}`)} | ${cell(routeText(r.id, "summary", t)!)} | ${accessText(r, t).scope} | ${accessText(r, t).pin} |`,
      ),
      "",
    );
    for (const r of rs) out.push(...routeSection(r, t));
  }
  out.push(
    `## ${cliTitle}`,
    "",
    t.dynamic("docs.api.cli.intro"),
    "",
    t.dynamic("docs.api.cli.header"),
    "| --- | --- | --- |",
    ...commands.map(
      (c) =>
        `| ${code(["daisy", ...c.path, ...c.args.map((a) => `<${a.name}>`)].join(" "))} | ${cell(routeText(c.route, "summary", t)!)}${c.pin ? t.dynamic("docs.api.cli.needsPin") : ""} | [${c.route}](#${anchor(c.route)}) |`,
    ),
    "",
    `<details><summary>${t.dynamic("docs.api.cli.helpTexts")}</summary>`,
    "",
    ...commands.flatMap((c) => ["```text", cliHelp(c, t), "```", ""]),
    "</details>",
    "",
    `## ${exemptTitle}`,
    "",
    t.dynamic("docs.api.exempt.intro"),
    "",
    t.dynamic("docs.api.exempt.header"),
    "| --- | --- | --- |",
    ...exempted.map(
      (e) =>
        `| [${e.route}](#${anchor(e.route)}) | ${code(`${e.method} ${e.path}`)} | ${cell(exemptText(routes.find((r) => r.id === e.route)!, t) ?? "")} |`,
    ),
    "",
  );
  // Explicit anchors for the route headings (renderers differ on ids).
  return out
    .join("\n")
    .replace(
      /^### (\S+)$/gm,
      (_, id: string) => `<a id="${anchor(id)}"></a>\n\n### ${id}`,
    );
}

/** docs/api/openapi.json (OpenAPI 3.1, `x-daisy-*` for scope, PIN, channels, command). */
export function apiOpenApi({ routes, groups, apiVersion, t }: DocsInput) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const p = literalPath(r.path.replace(/(?<!:):([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}"));
    const parameters = (["params", "query"] as const).flatMap((where) => {
      const s = r[where];
      if (!s) return [];
      const js = localizeSchema(inputJsonSchema(s), t);
      const req = new Set<string>(js.required || []);
      return Object.entries((js.properties || {}) as Record<string, any>).map(
        ([name, schema]) => ({
          name,
          in: where === "params" ? "path" : "query",
          required:
            where === "params" ||
            (req.has(name) && schema.default === undefined),
          ...(schema.description ? { description: schema.description } : {}),
          schema,
        }),
      );
    });
    const ok =
      r.output.kind === "websocket"
        ? { "101": { description: `WebSocket: ${outputName(r, t)}` } }
        : {
            "200": {
              description: outputName(r, t),
              content:
                r.output.kind === "binary"
                  ? {
                      "application/octet-stream": {
                        schema: { type: "string", format: "binary" },
                      },
                    }
                  : {
                      "application/json": {
                        schema: r.output.schema
                          ? localizeSchema(inputJsonSchema(r.output.schema), t)
                          : { description: outputName(r, t) },
                      },
                    },
            },
          };
    (paths[p] ??= {})[r.method.toLowerCase()] = {
      operationId: r.id,
      tags: [groupTitle(r.group, t)],
      summary: routeText(r.id, "summary", t),
      ...(routeText(r.id, "description", t) ? { description: routeText(r.id, "description", t) } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(documentedBody(r)
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: localizeSchema(inputJsonSchema(documentedBody(r)!), t),
                },
              },
            },
          }
        : {}),
      responses: ok,
      "x-daisy-scope": r.scope,
      "x-daisy-pin": r.pin,
      ...(r.pinOn ? { "x-daisy-pin-on": r.pinOn } : {}),
      ...(r.letsIn ? { "x-daisy-lets-in": r.letsIn } : {}),
      "x-daisy-channels": r.channels,
      ...(r.visitors ? { "x-daisy-visitors": true } : {}),
      ...(r.idempotencyKey
        ? { "x-daisy-idempotency": `body.${r.idempotencyKey}` }
        : {}),
      ...(r.aiSelf ? { "x-daisy-ai-self": r.aiSelf } : {}),
      ...(r.auth ? { "x-daisy-auth": r.auth } : {}),
      ...(r.external ? { "x-daisy-external": r.external } : {}),
      "x-daisy-audit": r.audit,
      "x-daisy-cli": c0(r) ? { command: c0(r)! } : { exempt: exemptText(r, t) },
      ...(r.errors?.length ? { "x-daisy-errors": r.errors } : {}),
      ...(r.removal ? { deprecated: true, "x-daisy-removal": { ...r.removal, why: routeText(r.id, "removal", t) } } : {}),
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: t.dynamic("docs.api.openapi.title"),
      version: String(apiVersion),
      description: t.dynamic("docs.api.openapi.description"),
    },
    tags: groups.map((g) => ({ name: groupTitle(g.id, t) })),
    paths,
  };
}
