#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { readAndValidateTestReceipt } from "./test_receipt.mjs";

const FORBIDDEN_PARTS = new Set([
  ".git",
  "secrets",
  "runtime_state",
  "uploads",
  "tmp",
]);

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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(filename) {
  return sha256(readFileSync(filename));
}

function normalizedRelative(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/, "");
  const parts = normalized.split("/");
  if (!normalized || path.isAbsolute(value) || parts.some((part) =>
    part === "" || part === "." || part === ".." || FORBIDDEN_PARTS.has(part))) {
    throw new Error(`unsafe or forbidden release path: ${value}`);
  }
  return normalized;
}

function exactIdentifierSet(value) {
  if (!Array.isArray(value)
      || value.length === 0
      || value.some((item) => typeof item !== "string"
        || !/^[A-Za-z0-9._-]+$/u.test(item))
      || new Set(value).size !== value.length) {
    return null;
  }
  return [...value].sort();
}

export function validatedManagerIntegrationApi(candidate, entrypoints) {
  const entrypoint = candidate?.entrypoint;
  const operations = exactIdentifierSet(candidate?.operations);
  if (candidate?.schema !== "uci_arena_manager_service_api_v1"
      || candidate.version !== "1.0"
      || candidate.transport !== "cli_json"
      || typeof entrypoint !== "string"
      || !Object.hasOwn(entrypoints, entrypoint)
      || !Array.isArray(candidate.arguments)
      || candidate.arguments.length !== 1
      || candidate.arguments[0] !== "api"
      || !operations
      || !operations.includes("describe")
      || !operations.includes("status")
      || !operations.includes("outputs_list")
      || !operations.includes("outputs_inspect")
      || !operations.includes("config_validate")
      || candidate.output_schema !== "uci_arena_service_output_v1") {
    throw new Error("invalid Manager integration API declaration");
  }
  return {
    ...candidate,
    operations: [...candidate.operations],
  };
}

function listFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const rows = [];
  for (const name of readdirSync(directory).sort()) {
    const childRelative = relative ? `${relative}/${name}` : name;
    const normalized = normalizedRelative(childRelative);
    const absolute = path.join(root, normalized);
    const entry = lstatSync(absolute);
    if (entry.isSymbolicLink()) {
      throw new Error(`symbolic links are forbidden in component payloads: ${normalized}`);
    }
    if (entry.isDirectory()) rows.push(...listFiles(root, normalized));
    else if (entry.isFile()) rows.push(normalized);
    else throw new Error(`unsupported component filesystem entry: ${normalized}`);
  }
  return rows;
}

function copyDefinitionFiles(repositoryRoot, staging, definition) {
  const mappings = [
    ...definition.include,
    ...(definition.include_by_target?.[definition.target_triple] ?? []),
  ];
  for (const mapping of mappings) {
    const sourceRelative = normalizedRelative(mapping.source);
    const targetRelative = mapping.target === "." ? "" : normalizedRelative(mapping.target);
    const source = path.join(repositoryRoot, sourceRelative);
    const target = path.join(staging, targetRelative);
    if (!existsSync(source)) {
      if (mapping.required === false) continue;
      throw new Error(`required component source is missing: ${sourceRelative}`);
    }
    const sourceStat = statSync(source);
    if (sourceStat.isDirectory()) {
      for (const relative of listFiles(source)) {
        const destination = path.join(target, relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(path.join(source, relative), destination);
      }
    } else if (sourceStat.isFile()) {
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
    } else {
      throw new Error(`unsupported component source: ${sourceRelative}`);
    }
  }
}

function writeOctal(buffer, offset, length, value) {
  const encoded = Math.trunc(value).toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) throw new Error(`tar numeric field overflow: ${value}`);
  buffer.write(encoded, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function splitTarPath(relative) {
  const bytes = Buffer.byteLength(relative);
  if (bytes <= 100) return { name: relative, prefix: "" };
  for (let index = relative.lastIndexOf("/"); index > 0; index = relative.lastIndexOf("/", index - 1)) {
    const prefix = relative.slice(0, index);
    const name = relative.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`component path is too long for deterministic ustar: ${relative}`);
}

function tarHeader(relative, size, mode, sourceDateEpoch) {
  const { name, prefix } = splitTarPath(relative);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, sourceDateEpoch);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  header.write(prefix, 345, 155, "utf8");
  const checksum = header.reduce((sum, value) => sum + value, 0);
  const encoded = checksum.toString(8).padStart(6, "0");
  header.write(encoded, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function deterministicTarGz(staging, sourceDateEpoch) {
  const chunks = [];
  for (const relative of listFiles(staging)) {
    const absolute = path.join(staging, relative);
    const bytes = readFileSync(absolute);
    const executable = (statSync(absolute).mode & 0o111) !== 0;
    chunks.push(tarHeader(relative, bytes.length, executable ? 0o755 : 0o644, sourceDateEpoch));
    chunks.push(bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

function git(repositoryRoot, args) {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function sourceIdentity(repositoryRoot) {
  const commit = git(repositoryRoot, ["rev-parse", "HEAD"]);
  const status = git(repositoryRoot, ["status", "--porcelain", "--untracked-files=no"]);
  const tree = git(repositoryRoot, ["ls-tree", "-r", "--full-tree", "HEAD"]);
  return {
    commit,
    clean: status.length === 0,
    treeSha256: sha256(Buffer.from(tree, "utf8")),
  };
}

export function buildComponent({
  repositoryRoot,
  definitionPath,
  version,
  target,
  outputDirectory,
  sourceDateEpoch,
  workflowIdentity,
  testReceiptPath,
  allowDirty = false,
}) {
  const definition = JSON.parse(readFileSync(definitionPath, "utf8"));
  if (definition.schema !== "arena_provider_component_definition_v1"
      || !/^[A-Za-z0-9._-]+$/.test(definition.component_id)
      || !Array.isArray(definition.include)
      || definition.include.length === 0) {
    throw new Error("invalid provider component definition");
  }
  if (definition.package_json !== undefined) {
    const packageRelative = normalizedRelative(definition.package_json);
    const packagePath = path.join(repositoryRoot, packageRelative);
    if (!existsSync(packagePath) || !statSync(packagePath).isFile()) {
      throw new Error(`component package manifest is missing: ${packageRelative}`);
    }
    const packageManifest = JSON.parse(readFileSync(packagePath, "utf8"));
    if (packageManifest.version !== version) {
      throw new Error(
        `component version ${version} does not match ${packageRelative} version `
        + `${packageManifest.version ?? "<missing>"}`,
      );
    }
  }
  const identity = sourceIdentity(repositoryRoot);
  if (!identity.clean && !allowDirty) {
    throw new Error("provider component releases require a clean tracked worktree");
  }
  if (!testReceiptPath) {
    throw new Error("provider component releases require an exact test receipt");
  }
  const testEvidence = readAndValidateTestReceipt({
    filename: testReceiptPath,
    definition,
    target,
    sourceCommit: identity.commit,
    workflowIdentity,
  });
  const releaseRoot = path.resolve(outputDirectory);
  definition.target_triple = target;
  const staging = path.join(
    releaseRoot,
    `.staging-${definition.component_id}-${process.pid}`,
  );
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    copyDefinitionFiles(repositoryRoot, staging, definition);
    const payloadFiles = listFiles(staging).map((relative) => ({
      path: relative,
      sha256: sha256File(path.join(staging, relative)),
      size_bytes: statSync(path.join(staging, relative)).size,
    }));
    const sbom = {
      spdxVersion: "SPDX-2.3",
      dataLicense: "CC0-1.0",
      SPDXID: "SPDXRef-DOCUMENT",
      name: `${definition.component_id}-${version}-${target}`,
      documentNamespace: `https://uci-arena.example/spdx/${identity.commit}/${definition.component_id}/${target}`,
      creationInfo: {
        created: new Date(Number(sourceDateEpoch) * 1000).toISOString(),
        creators: [`Tool: UCI-Arena-provider-release/1`],
      },
      files: payloadFiles.map((file, index) => ({
        fileName: `./${file.path}`,
        SPDXID: `SPDXRef-File-${index + 1}`,
        checksums: [{ algorithm: "SHA256", checksumValue: file.sha256 }],
      })),
    };
    writeFileSync(path.join(staging, "sbom.spdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);
    const files = listFiles(staging).map((relative) => ({
      path: relative,
      sha256: sha256File(path.join(staging, relative)),
      size_bytes: statSync(path.join(staging, relative)).size,
    }));
    const entrypoints = definition.entrypoints_by_target?.[target]
      ?? definition.entrypoints
      ?? {};
    for (const [name, value] of Object.entries(entrypoints)) {
      const relative = normalizedRelative(value);
      if (!files.some((file) => file.path === relative)) {
        throw new Error(`component entrypoint ${name} is not in the payload: ${relative}`);
      }
    }
    let managerIntegrationApi;
    if (definition.manager_integration_api !== undefined) {
      managerIntegrationApi = validatedManagerIntegrationApi(
        definition.manager_integration_api,
        entrypoints,
      );
    }
    let contractManifest;
    if (definition.contract_manifest !== undefined) {
      contractManifest = normalizedRelative(definition.contract_manifest);
      if (!files.some((file) => file.path === contractManifest)) {
        throw new Error(
          `component contract manifest is not in the payload: ${contractManifest}`,
        );
      }
      const contract = JSON.parse(
        readFileSync(path.join(staging, contractManifest), "utf8"),
      );
      const contractCapabilities = exactIdentifierSet(contract.capabilities);
      const definitionCapabilities = exactIdentifierSet(definition.capabilities);
      const contractDataPaths = exactIdentifierSet(contract.data_paths);
      const definitionDataPaths = exactIdentifierSet(definition.data_paths);
      if (contract.schema !== "uci_arena_standalone_service_contract_v1"
          || contract.component_id !== definition.component_id
          || contract.component_version !== version
          || contract.cli_entrypoint !== entrypoints.cli
          || !contractCapabilities
          || !definitionCapabilities
          || JSON.stringify(contractCapabilities)
            !== JSON.stringify(definitionCapabilities)
          || !contractDataPaths
          || !definitionDataPaths
          || JSON.stringify(contractDataPaths) !== JSON.stringify(definitionDataPaths)
          || !/^[A-Za-z0-9._-]+$/u.test(contract.configuration_schema ?? "")
          || !/^[A-Za-z0-9._-]+$/u.test(contract.status_schema ?? "")
          || contract.startup?.windows !== definition.startup?.windows
          || contract.startup?.linux !== definition.startup?.linux
          || contract.health_smoke?.command !== "status"
          || contract.health_smoke?.success !== "exit_zero_and_status_schema"
          || JSON.stringify(contract.manager_integration_api ?? null)
            !== JSON.stringify(definition.manager_integration_api ?? null)
          || contract.persistence?.upgrade !== "preserve_and_migrate"
          || contract.persistence?.repair !== "preserve"
          || contract.persistence?.uninstall_default !== "preserve"
          || contract.outputs === null
          || typeof contract.outputs !== "object"
          || Array.isArray(contract.outputs)) {
        throw new Error(
          `standalone service contract does not match ${definition.component_id}@${version}`,
        );
      }
    }
    const manifest = {
      schema: "arena_install_component_v1",
      schema_version: 1,
      component_id: definition.component_id,
      component_version: version,
      target_triple: target,
      entrypoints,
      ...(contractManifest ? { contract_manifest: contractManifest } : {}),
      ...(managerIntegrationApi
        ? { manager_integration_api: managerIntegrationApi }
        : {}),
      capabilities: definition.capabilities ?? [],
      dependencies: definition.dependencies ?? [],
      ...(definition.default_model ? { default_model: definition.default_model } : {}),
      startup: definition.startup ?? {},
      data_paths: definition.data_paths ?? [],
      files,
    };
    writeFileSync(
      path.join(staging, "arena-component.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const licenseFiles = payloadFiles.filter((file) =>
      /(^|\/)(license|copying)(\.|$)/i.test(file.path));
    if (licenseFiles.length === 0) {
      throw new Error("component payload must contain at least one license file");
    }
    const licenseDigest = sha256(Buffer.concat(
      licenseFiles.map((file) => readFileSync(path.join(staging, file.path))),
    ));

    const first = deterministicTarGz(staging, Number(sourceDateEpoch));
    const second = deterministicTarGz(staging, Number(sourceDateEpoch));
    if (!first.equals(second)) throw new Error("component archive is not reproducible");
    mkdirSync(releaseRoot, { recursive: true });
    const artifactName = `${definition.component_id}-${version}-${target}.tar.gz`;
    const artifactPath = path.join(releaseRoot, artifactName);
    writeFileSync(artifactPath, first);
    const result = {
      schema: "arena_provider_release_result_v1",
      component_id: definition.component_id,
      component_version: version,
      target_triple: target,
      artifact_name: artifactName,
      artifact_sha256: sha256(first),
      artifact_size_bytes: first.length,
      component_manifest_sha256: sha256File(path.join(staging, "arena-component.json")),
      source_repository: definition.source_repository ?? "iteathen/UCI_Arena",
      source_commit: identity.commit,
      source_tree_sha256: identity.treeSha256,
      clean_tree: identity.clean,
      release_authority: "provider_component_only",
      suite_installer_authority: "iteathen/uci-arena-installer",
      workflow_identity: workflowIdentity,
      toolchain_identity: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
      dependency_lock_identities: definition.dependency_lock_identities ?? {},
      build_flags: definition.build_flags ?? [],
      sbom_sha256: sha256File(path.join(staging, "sbom.spdx.json")),
      licenses_sha256: licenseDigest,
      test_receipt_sha256: testEvidence.sha256,
      tests: testEvidence.receipt.tests,
    };
    const resultPath = path.join(
      releaseRoot,
      `${definition.component_id}-${version}-${target}.provider-result.json`,
    );
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    return { artifactPath, resultPath, result };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  for (const required of [
    "definition", "version", "target", "output-dir", "source-date-epoch",
    "workflow-identity", "test-receipt",
  ]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  const repositoryRoot = path.resolve(args["repository-root"] ?? process.cwd());
  const result = buildComponent({
    repositoryRoot,
    definitionPath: path.resolve(args.definition),
    version: args.version,
    target: args.target,
    outputDirectory: args["output-dir"],
    sourceDateEpoch: args["source-date-epoch"],
    workflowIdentity: args["workflow-identity"],
    testReceiptPath: path.resolve(args["test-receipt"]),
    allowDirty: args["allow-dirty"] === "true",
  });
  process.stdout.write(`${JSON.stringify(result.result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`component-release: ${error.message}\n`);
    process.exitCode = 1;
  }
}
