#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vendor = path.join(root, "vendor");
const lockPath = path.join(vendor, "upstream.lock.json");

function walk(directory, relative = "") {
  const rows = [];
  for (const name of readdirSync(directory).sort()) {
    if (!relative && name === "upstream.lock.json") continue;
    const child = relative ? `${relative}/${name}` : name;
    const absolute = path.join(directory, name);
    const entry = lstatSync(absolute);
    if (entry.isSymbolicLink()) throw new Error(`vendor symlink is forbidden: ${child}`);
    if (entry.isDirectory()) rows.push(...walk(absolute, child));
    else if (entry.isFile()) rows.push(child.replaceAll("\\", "/"));
  }
  return rows;
}

const files = Object.fromEntries(walk(vendor).map((name) => [
  name,
  createHash("sha256").update(readFileSync(path.join(vendor, name))).digest("hex"),
]));

if (process.argv.includes("--write")) {
  const lock = {
    schema: "uci_arena_upstream_vendor_lock_v1",
    source_repository: "iteathen/UCI_Arena",
    source_commit: "8f2d7fe9b3e2d3484c7b6875ffa61347efb6b771",
    packages: {
      "@uci-arena/background-service-runtime": "1.0.0",
    },
    files,
  };
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  process.stdout.write(`wrote ${lockPath}\n`);
  process.exit(0);
}

const lock = JSON.parse(readFileSync(lockPath, "utf8"));
if (lock.schema !== "uci_arena_upstream_vendor_lock_v1"
    || lock.source_repository !== "iteathen/UCI_Arena"
    || !/^[0-9a-f]{40}$/u.test(lock.source_commit ?? "")
    || JSON.stringify(lock.files) !== JSON.stringify(files)) {
  throw new Error("vendored upstream package closure does not match its exact lock");
}
process.stdout.write("book-forge vendor lock: pass\n");
