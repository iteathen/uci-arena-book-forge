#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const excluded = new Set([".git", "node_modules", "vendor"]);
const errors = [];

function files(directory, relative = "") {
  const rows = [];
  for (const name of readdirSync(directory).sort()) {
    if (!relative && excluded.has(name)) continue;
    const childRelative = relative ? `${relative}/${name}` : name;
    const absolute = path.join(directory, name);
    const entry = lstatSync(absolute);
    if (entry.isSymbolicLink()) {
      errors.push(`symbolic link is forbidden: ${childRelative}`);
    } else if (entry.isDirectory()) {
      rows.push(...files(absolute, childRelative));
    } else if (entry.isFile() && /\.(?:mjs|js)$/u.test(name)) {
      rows.push({ absolute, relative: childRelative });
    }
  }
  return rows;
}

for (const file of files(root)) {
  const source = readFileSync(file.absolute, "utf8");
  if (/services[\\/]+evidence-service|tools[\\/]+arena_evidence_service/u.test(source)) {
    errors.push(`${file.relative} references Evidence Service source`);
  }
  const imports = source.matchAll(
    /(?:from\s*|import\s*\()\s*["']([^"']+)["']/gu,
  );
  for (const match of imports) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    const resolved = path.resolve(path.dirname(file.absolute), specifier);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      errors.push(`${file.relative} imports outside the repository: ${specifier}`);
    }
  }
}

const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
for (const [name, value] of Object.entries(manifest.dependencies ?? {})) {
  if (value.startsWith("file:") && !value.startsWith("file:vendor/")) {
    errors.push(`dependency ${name} escapes the repository: ${value}`);
  }
}

if (errors.length) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("book-forge repository boundary: pass\n");
