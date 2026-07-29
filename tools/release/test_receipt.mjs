import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const SAFE_ID = /^[A-Za-z0-9._:/@#-]+$/;

export function expectedTests(definition, target) {
  const names = [
    ...(definition.tests ?? []),
    ...(definition.tests_by_target?.[target] ?? []),
  ];
  if (names.length === 0
      || names.some((name) => typeof name !== "string" || !SAFE_ID.test(name))
      || new Set(names).size !== names.length) {
    throw new Error("component definition has an invalid expected test set");
  }
  return names;
}

export function canonicalReceipt(receipt) {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export function readAndValidateTestReceipt({
  filename,
  definition,
  target,
  sourceCommit,
  workflowIdentity,
}) {
  const bytes = readFileSync(filename);
  const receipt = JSON.parse(bytes.toString("utf8"));
  const expected = expectedTests(definition, target);
  if (receipt?.schema !== "arena_provider_test_receipt_v1"
      || receipt.component_id !== definition.component_id
      || receipt.target_triple !== target
      || receipt.source_commit !== sourceCommit
      || receipt.workflow_identity !== workflowIdentity
      || !Array.isArray(receipt.tests)
      || receipt.tests.length !== expected.length) {
    throw new Error("provider test receipt identity does not match this release");
  }
  const seen = new Set();
  for (let index = 0; index < expected.length; index += 1) {
    const row = receipt.tests[index];
    if (row?.name !== expected[index] || row.status !== "passed" || seen.has(row.name)) {
      throw new Error("provider test receipt does not prove the exact expected passed tests");
    }
    seen.add(row.name);
  }
  return {
    receipt,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
