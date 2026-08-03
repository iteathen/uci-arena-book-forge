#!/usr/bin/env node

const changedIndex = process.argv.indexOf("--changed-files");
const changed = changedIndex < 0 ? [] : process.argv.slice(changedIndex + 1);
const specs = new Set([
  "specs/00_READ_FIRST.yaml",
  "specs/repository_boundary_v1.yaml",
]);
if (changed.length === 0 || changed.some((name) =>
  /^(src|test|fixtures|policy|contracts|release|tools|package)/u.test(name))) {
  specs.add("specs/opening_book_forge_v1.yaml");
}
if (changed.length === 0 || changed.some((name) =>
  name === "src/config.mjs"
  || name.startsWith("test/config")
  || name === "specs/configuration_contract_v1.yaml"
  || name === "tools/spec-preflight.mjs")) {
  specs.add("specs/configuration_contract_v1.yaml");
}
process.stdout.write(`${JSON.stringify({
  schema: "book_forge_spec_preflight_v1",
  required_specs: [...specs],
}, null, 2)}\n`);
