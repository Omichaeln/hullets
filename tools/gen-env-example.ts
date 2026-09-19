/**
 * Regenerate .env.example from the configuration schema.
 *
 * The file is documentation of what the system reads, so it is generated from
 * CONFIG_DOC rather than maintained by hand — a variable added to the schema
 * and forgotten here is a variable nobody deploying this knows about. Values
 * are defaults only; secrets are marked and never carry one.
 *
 *   npx tsx tools/gen-env-example.ts
 */
import fs from "node:fs";
import { CONFIG_DOC } from "@promo/core";

const lines = [
  "# Huletts promotion platform — configuration reference (names and descriptions only; never commit values).",
  "# Generated from packages/core/src/config.ts (CONFIG_DOC) by tools/gen-env-example.ts. Secrets are marked [secret].",
  "",
];
for (const v of CONFIG_DOC) {
  lines.push(`# ${v.description}${v.secret ? " [secret]" : ""}`);
  lines.push(`${v.name}=${v.secret ? "" : v.default}`);
  lines.push("");
}
fs.writeFileSync(".env.example", lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
console.log(`.env.example regenerated: ${CONFIG_DOC.length} variables`);
