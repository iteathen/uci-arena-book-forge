#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const workflowsRoot = path.join(root, ".github", "workflows");
const forbiddenTriggers = new Set([
  "pull_request",
  "push",
  "merge_group",
  "schedule",
]);

function workflowTriggers(source, filename) {
  const lines = source.split(/\r?\n/);
  const onLine = lines.findIndex((line) => /^on:\s*(?:#.*)?$/.test(line));
  if (onLine < 0) {
    throw new Error(`${filename}: missing block-form on declaration`);
  }
  const triggers = [];
  for (let index = onLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const match = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):/.exec(line);
    if (match) triggers.push(match[1]);
  }
  return triggers;
}

const failures = [];
const workflowNames = (await readdir(workflowsRoot))
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();
for (const name of workflowNames) {
  const source = await readFile(path.join(workflowsRoot, name), "utf8");
  const triggers = workflowTriggers(source, name);
  if (name === "ci.yml") {
    if (!triggers.includes("pull_request") || triggers.some(trigger => !["pull_request", "push", "workflow_dispatch"].includes(trigger))) {
      failures.push(`${name}: only pull request, branch push and manual CI are allowed`);
    }
    if (!/^permissions:\s*\n  contents: read\s*$/m.test(source) || /:\s*write\b|secrets\.|self-hosted|^\s*environment:/m.test(source)) {
      failures.push(`${name}: CI must be read-only, secret-free and GitHub-hosted`);
    }
    continue;
  }
  const forbidden = triggers.filter((trigger) => forbiddenTriggers.has(trigger));
  if (forbidden.length > 0) {
    failures.push(`${name}: forbidden automatic trigger(s): ${forbidden.join(", ")}`);
  }
  if (!triggers.includes("workflow_dispatch")) {
    failures.push(`${name}: release automation must require workflow_dispatch`);
  }
}
if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `github-automation: ${workflowNames.length} workflow(s), read-only CI and manual releases\n`,
);
