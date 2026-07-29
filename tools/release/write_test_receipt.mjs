#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { canonicalReceipt, expectedTests } from "./test_receipt.mjs";

function parseArguments(argv) {
  const values = { "passed-test": [] };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${flag ?? "<end>"}`);
    }
    const name = flag.slice(2);
    if (name === "passed-test") {
      values[name].push(value);
    } else {
      if (Object.hasOwn(values, name)) throw new Error(`duplicate --${name}`);
      values[name] = value;
    }
  }
  return values;
}

export function writeTestReceipt({
  repositoryRoot,
  definitionPath,
  target,
  outputPath,
  workflowIdentity,
  passedTests,
}) {
  const definition = JSON.parse(readFileSync(definitionPath, "utf8"));
  if (definition?.schema !== "arena_provider_component_definition_v1") {
    throw new Error("invalid provider component definition");
  }
  const sourceCommit = execFileSync(
    "git",
    ["-C", repositoryRoot, "rev-parse", "HEAD"],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  const expected = expectedTests(definition, target);
  if (!Array.isArray(passedTests)
      || passedTests.length !== expected.length
      || passedTests.some((name, index) => name !== expected[index])) {
    throw new Error("passed tests do not match the exact component and target test set");
  }
  const receipt = {
    schema: "arena_provider_test_receipt_v1",
    component_id: definition.component_id,
    target_triple: target,
    source_commit: sourceCommit,
    workflow_identity: workflowIdentity,
    tests: passedTests.map((name) => ({
      name,
      status: "passed",
    })),
  };
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, canonicalReceipt(receipt), "utf8");
  return receipt;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  for (const required of [
    "definition", "target", "output", "workflow-identity",
  ]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  if (args["passed-test"].length === 0) {
    throw new Error("at least one --passed-test is required");
  }
  const receipt = writeTestReceipt({
    repositoryRoot: path.resolve(args["repository-root"] ?? process.cwd()),
    definitionPath: path.resolve(args.definition),
    target: args.target,
    outputPath: path.resolve(args.output),
    workflowIdentity: args["workflow-identity"],
    passedTests: args["passed-test"],
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`write-test-receipt: ${error.message}\n`);
    process.exitCode = 1;
  }
}
