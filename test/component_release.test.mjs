import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  validatedActivation,
  validatedDiscovery,
  validateWindowsRuntimeOwnership,
} from "../tools/release/component_release.mjs";

test("component discovery is role-declared and locator-bounded", () => {
  assert.deepEqual(
    validatedDiscovery(
      [{ kind: "replacement_service", locator: { source: "entrypoint", entrypoint: "cli" } }],
      { cli: "service/cli.mjs" },
      [{ path: "service/cli.mjs" }],
    ),
    [{ kind: "replacement_service", locator: { source: "entrypoint", entrypoint: "cli" } }],
  );
  assert.throws(
    () => validatedDiscovery(
      [{ kind: "replacement_service", locator: { source: "component_path", path: "missing" } }],
      {},
      [{ path: "service/cli.mjs" }],
    ),
    /unlisted/u,
  );
});

test("knowledge activation is independent of component identity", () => {
  const discovery = [{
    kind: "opening_book",
    locator: { source: "component_path", path: "opening_books" },
  }];
  assert.deepEqual(
    validatedActivation(
      [{
        kind: "opening_book",
        source_path: "opening_books",
        destination_root: "knowledge_root",
        destination_path: "opening_books",
      }],
      discovery,
      [{ path: "opening_books/book.bin" }],
    ),
    [{
      kind: "opening_book",
      source_path: "opening_books",
      destination_root: "knowledge_root",
      destination_path: "opening_books",
    }],
  );
  assert.throws(
    () => validatedActivation(
      [{
        kind: "opening_book",
        source_path: "opening_books",
        destination_root: "knowledge_root",
        destination_path: "../outside",
      }],
      discovery,
      [{ path: "opening_books/book.bin" }],
    ),
    /unsafe/u,
  );
  assert.throws(
    () => validatedActivation(
      [{
        kind: "opening_book",
        source_path: "opening_books",
        destination_root: "knowledge_root",
        destination_path: "opening_books",
      }],
      [],
      [{ path: "opening_books/book.bin" }],
    ),
    /matching discovery/u,
  );
});

test("Windows release closure accepts application-local VC runtimes", () => {
  assert.doesNotThrow(() => validateWindowsRuntimeOwnership([
    { path: "services/book-forge/native/uci_arena_background_guard.exe" },
    { path: "services/book-forge/native/msvcp140.dll" },
    { path: "services/book-forge/native/vcruntime140.dll" },
  ], "windows-x86_64"));
});

test("Windows release closure rejects OS-owned runtime files", () => {
  for (const relative of [
    "services/book-forge/native/api-ms-win-core-file-l1-1-0.dll",
    "services/book-forge/native/ext-ms-win-ntuser-window-l1-1-0.dll",
    "services/book-forge/native/ucrtbase.dll",
    "services/book-forge/native/System32/kernel32.dll",
  ]) {
    assert.throws(
      () => validateWindowsRuntimeOwnership([{ path: relative }], "windows-x86_64"),
      /OS-owned Windows runtime files/u,
    );
  }
});

test("non-Windows release closure does not apply Windows ownership policy", () => {
  assert.doesNotThrow(() => validateWindowsRuntimeOwnership([
    { path: "fixture/ucrtbase.dll" },
  ], "linux-x86_64"));
});

test("provider release proves independent target-scoped native reproducibility", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/component-release.yml", import.meta.url),
    "utf8",
  );
  const definition = JSON.parse(readFileSync(
    new URL("../release/components/book-forge.json", import.meta.url),
    "utf8",
  ));
  const nativeCmake = readFileSync(
    new URL("../vendor/background-service-runtime/native/CMakeLists.txt", import.meta.url),
    "utf8",
  );

  assert.deepEqual(Object.keys(definition.native_toolchain_by_target), ["windows-x86_64"]);
  assert.deepEqual(definition.discovery, [
    { kind: "book_forge", locator: { source: "active_root" } },
  ]);
  const openingBookDefinition = JSON.parse(readFileSync(
    new URL("../release/components/opening-book.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(openingBookDefinition.discovery, [
    { kind: "opening_book", locator: { source: "component_path", path: "opening_books" } },
  ]);
  assert.equal(openingBookDefinition.activation[0].destination_root, "knowledge_root");
  assert.equal(
    definition.entrypoints.installer_integration,
    "services/book-forge/src/installer_integration.mjs",
  );
  assert.equal(
    definition.installer_integration.invocation.runtime_component_id,
    "node_runtime.private",
  );
  assert.equal(definition.installer_integration.workspace_placement, "product_data");
  assert.deepEqual(
    definition.installer_integration.dependency_bindings.map((binding) => binding.name),
    ["stockfish"],
  );
  assert.equal(definition.installer_integration.startup_control.entrypoint, "cli");
  assert.deepEqual(
    definition.installer_integration.startup_control.actions,
    { install: ["startup", "install"], uninstall: ["startup", "uninstall"] },
  );
  assert.equal(
    definition.installer_integration.startup_control.result.envelope,
    "startup",
  );
  assert.match(workflow, /build\/native-repro/u);
  assert.match(workflow, /provider_stage\/background_service_native_repro/u);
  assert.match(workflow, /provider_stage\/opening_book_repro/u);
  assert.match(workflow, /native_toolchain_receipt\.mjs/u);
  assert.match(workflow, /dist\/provider-repro/u);
  assert.match(workflow, /Independent component builds differ:/u);
  assert.match(workflow, /first_path=/u);
  assert.match(workflow, /Independent component provider results differ/u);
  assert.match(workflow, /contents:\s*write/u);
  assert.match(workflow, /default:\s*github-hosted/u);
  assert.match(
    workflow,
    /\["self-hosted","Windows","X64","ephemeral","uci-suite","book-forge-release"\]/u,
  );
  assert.match(workflow, /ephemeral self-hosted release is Windows-only/u);
  assert.match(workflow, /\('cl\.exe', 'gh\.exe', 'git\.exe', 'msbuild\.exe'\)/u);
  assert.doesNotMatch(workflow, /actions\/(?:upload|download)-artifact/u);
  assert.match(workflow, /Expected exactly three candidate assets/u);
  assert.match(workflow, /gh release view \$tag[\s\S]*?targetCommitish[\s\S]*?isPrerelease[\s\S]*?assets/u);
  assert.match(workflow, /targetCommitish -ne \$env:GITHUB_SHA/u);
  assert.match(workflow, /@\(\$release\.assets\)\.Count -ne 0/u);
  assert.match(workflow, /gh release upload \$tag @assetPaths/u);
  assert.match(workflow, /@\(\$published\.assets\)\.Count -ne 3/u);
  assert.match(workflow, /remote\[0\]\.size -ne \$asset\.Length/u);
  assert.match(workflow, /remote\[0\]\.digest -ne \$expectedDigest/u);
  assert.doesNotMatch(workflow, /gh release create/u);
  assert.ok(workflow.indexOf("provider_attestation.mjs verify-bundle")
    < workflow.indexOf("gh release upload"));
  assert.match(nativeCmake, /target_link_options\(uci_arena_background_guard PRIVATE \/Brepro\)/u);
  assert.match(nativeCmake, /target_link_options\(uci_arena_service_launcher PRIVATE \/Brepro\)/u);
});
