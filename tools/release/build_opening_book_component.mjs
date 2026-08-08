#!/usr/bin/env node

import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Catalog } from "../../src/catalog.mjs";
import {
  buildSnapshot,
  validateSnapshot,
} from "../../src/compiler.mjs";
import { loadConfig } from "../../src/config.mjs";
import {
  ingestSource,
  registerInput,
} from "../../src/ingest.mjs";

async function main() {
  const outputFlag = process.argv.indexOf("--output");
  if (outputFlag < 0 || !process.argv[outputFlag + 1]) {
    throw new Error("--output is required");
  }
  const output = path.resolve(process.argv[outputFlag + 1]);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "arena-opening-book-"));
  try {
    const config = await loadConfig({ workspace });
    config.acquisition.enabled = false;
    config.analysis.enabled = false;
    const catalog = new Catalog(config);
    let snapshot;
    try {
      const source = await registerInput(catalog, { fixtureId: "bootstrap_v1" });
      await ingestSource(catalog, source, config);
      snapshot = await buildSnapshot(catalog, config, "integration");
    } finally {
      catalog.close();
    }
    const validation = await validateSnapshot(snapshot.directory);
    if (validation.channel !== "integration" || validation.qualified) {
      throw new Error("Book Forge did not produce a valid integration snapshot");
    }
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    for (const name of [
      "strong_rare_v1.bin",
      "strong_rare_v1.stats",
      "strong_rare_v1.policy",
      "snapshot.manifest.json",
      "evaluation.audit.jsonl",
    ]) {
      await cp(path.join(snapshot.directory, name), path.join(output, name));
    }
    process.stdout.write(`${JSON.stringify({
      schema: "arena_opening_book_bootstrap_build_v1",
      status: "integration_not_strength_qualified",
      output,
      validation,
    })}\n`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`opening-book-release: ${error.message}\n`);
  process.exitCode = 1;
});
