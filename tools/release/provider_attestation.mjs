#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const PROVIDER_PREDICATE_TYPE =
  "https://uci-arena.example/attestations/provider-release-result/v1";
export const INTOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const SIGSTORE_BUNDLE_MEDIA_TYPE =
  "application/vnd.dev.sigstore.bundle.v0.3+json";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${flag ?? "<end>"}`);
    }
    values[flag.slice(2)] = value;
  }
  return values;
}

function readJson(filename) {
  return JSON.parse(readFileSync(filename, "utf8"));
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256File(filename) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(filename, "r");
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function safeAssetName(value, label) {
  if (typeof value !== "string"
      || !SAFE_ASSET_NAME_PATTERN.test(value)
      || path.basename(value) !== value) {
    throw new Error(`${label} must be a safe release asset basename`);
  }
  return value;
}

function decodeCanonicalBase64(value) {
  if (typeof value !== "string"
      || value.length === 0
      || value.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("Sigstore bundle DSSE payload is not canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("Sigstore bundle DSSE payload is not canonical base64");
  }
  return decoded;
}

export function buildProviderStatement(providerResult) {
  if (providerResult?.schema !== "arena_provider_release_result_v1") {
    throw new Error("provider result has the wrong schema");
  }
  const artifactName = safeAssetName(providerResult.artifact_name, "artifact_name");
  if (!SHA256_PATTERN.test(providerResult.artifact_sha256 ?? "")) {
    throw new Error("provider result artifact_sha256 must be lowercase SHA-256");
  }
  return {
    _type: INTOTO_STATEMENT_TYPE,
    subject: [{
      name: artifactName,
      digest: { sha256: providerResult.artifact_sha256 },
    }],
    predicateType: PROVIDER_PREDICATE_TYPE,
    predicate: providerResult,
  };
}

export function prepareProviderAttestation(outputDirectory, statementDirectory) {
  const outputRoot = path.resolve(outputDirectory);
  const resultNames = readdirSync(outputRoot)
    .filter((name) => name.endsWith(".provider-result.json"))
    .sort();
  if (resultNames.length !== 1) {
    throw new Error(
      `expected exactly one provider result in ${outputRoot}; found ${resultNames.length}`,
    );
  }

  const providerResultName = safeAssetName(resultNames[0], "provider result name");
  const providerResultPath = path.join(outputRoot, providerResultName);
  const providerResult = readJson(providerResultPath);
  const statement = buildProviderStatement(providerResult);
  const artifactName = statement.subject[0].name;
  const artifactPath = path.join(outputRoot, artifactName);
  const actualArtifactSha256 = sha256File(artifactPath);
  if (actualArtifactSha256 !== providerResult.artifact_sha256) {
    throw new Error("provider result artifact digest does not match the candidate bytes");
  }

  const statementRoot = path.resolve(statementDirectory);
  mkdirSync(statementRoot, { recursive: true });
  const statementPath = path.join(statementRoot, `${artifactName}.intoto.json`);
  const bundleName = safeAssetName(
    `${artifactName}.sigstore.json`,
    "Sigstore bundle name",
  );
  const bundlePath = path.join(outputRoot, bundleName);
  writeFileSync(statementPath, canonicalJson(statement), { flag: "wx" });

  return {
    artifactName,
    artifactPath,
    bundleName,
    bundlePath,
    predicateType: PROVIDER_PREDICATE_TYPE,
    providerResultName,
    providerResultPath,
    statementPath,
  };
}

export function verifyBundlePayload(bundlePath, statementPath) {
  const bundle = readJson(bundlePath);
  if (bundle?.mediaType !== SIGSTORE_BUNDLE_MEDIA_TYPE) {
    throw new Error("unsupported Sigstore bundle media type");
  }
  if (bundle?.dsseEnvelope?.payloadType !== "application/vnd.in-toto+json") {
    throw new Error("Sigstore bundle does not contain an in-toto DSSE payload");
  }
  if (!Array.isArray(bundle.dsseEnvelope.signatures)
      || bundle.dsseEnvelope.signatures.length !== 1) {
    throw new Error("Sigstore bundle must contain exactly one DSSE signature");
  }
  const actualStatement = JSON.parse(
    decodeCanonicalBase64(bundle.dsseEnvelope.payload).toString("utf8"),
  );
  const expectedStatement = readJson(statementPath);
  if (!isDeepStrictEqual(actualStatement, expectedStatement)) {
    throw new Error("Sigstore bundle payload does not match the expected provider statement");
  }
  return actualStatement;
}

function writeGitHubOutputs(filename, values) {
  for (const [name, value] of Object.entries(values)) {
    const text = String(value);
    if (/[\u0000-\u001f\u007f]/u.test(text)) {
      throw new Error(`unsafe GitHub output value for ${name}`);
    }
    appendFileSync(filename, `${name}=${text}\n`, "utf8");
  }
}

function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArguments(rest);
  if (command === "prepare") {
    const prepared = prepareProviderAttestation(
      args["output-dir"],
      args["statement-dir"],
    );
    if (args["github-output"]) {
      writeGitHubOutputs(args["github-output"], {
        artifact_path: prepared.artifactPath,
        bundle_path: prepared.bundlePath,
        predicate_type: prepared.predicateType,
        statement_path: prepared.statementPath,
      });
    } else {
      process.stdout.write(canonicalJson(prepared));
    }
    return;
  }
  if (command === "verify-bundle") {
    verifyBundlePayload(args.bundle, args.statement);
    process.stdout.write("provider-attestation: bundle payload verified\n");
    return;
  }
  throw new Error("usage: provider_attestation.mjs <prepare|verify-bundle> [options]");
}

if (process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`provider-attestation: ${error.message}\n`);
    process.exitCode = 1;
  }
}
