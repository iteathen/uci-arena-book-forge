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

const TEXT_EXTENSIONS = new Set([
  ".cpp",
  ".h",
  ".hpp",
  ".json",
  ".md",
  ".mjs",
  ".ps1",
  ".txt",
  ".yaml",
  ".yml",
]);

export function canonicalVendorBytes(name, bytes) {
  const basename = path.posix.basename(name);
  if (basename !== "CMakeLists.txt"
      && !TEXT_EXTENSIONS.has(path.posix.extname(name))) {
    return bytes;
  }
  return Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"), "utf8");
}

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
  createHash("sha256")
    .update(canonicalVendorBytes(name, readFileSync(path.join(vendor, name))))
    .digest("hex"),
]));

if (process.argv.includes("--write")) {
  const lock = {
    schema: "uci_arena_upstream_vendor_lock_v1",
    source_repository: "iteathen/uci-arena-engine",
    source_commit: "0955df3982b8df89069181c05a02328c00811bbb",
    packages: {
      "@uci-arena/background-service-runtime": "1.3.0",
    },
    files,
  };
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  process.stdout.write(`wrote ${lockPath}\n`);
  process.exit(0);
}

const lock = JSON.parse(readFileSync(lockPath, "utf8"));
if (lock.schema !== "uci_arena_upstream_vendor_lock_v1"
    || lock.source_repository !== "iteathen/uci-arena-engine"
    || lock.source_commit !== "0955df3982b8df89069181c05a02328c00811bbb"
    || lock.packages?.["@uci-arena/background-service-runtime"] !== "1.3.0"
    || Object.keys(lock.packages ?? {}).length !== 1
    || JSON.stringify(lock.files) !== JSON.stringify(files)) {
  throw new Error("vendored upstream package closure does not match its exact lock");
}
process.stdout.write("book-forge vendor lock: pass\n");
