import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateWindowsRuntimeOwnership } from "../tools/release/component_release.mjs";

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
  assert.match(workflow, /build\/native-repro/u);
  assert.match(workflow, /provider_stage\/background_service_native_repro/u);
  assert.match(workflow, /provider_stage\/opening_book_repro/u);
  assert.match(workflow, /native_toolchain_receipt\.mjs/u);
  assert.match(workflow, /dist\/provider-repro/u);
  assert.match(workflow, /Independent component builds differ:/u);
  assert.match(workflow, /first_path=/u);
  assert.match(workflow, /Independent component provider results differ/u);
  assert.match(nativeCmake, /target_link_options\(uci_arena_background_guard PRIVATE \/Brepro\)/u);
  assert.match(nativeCmake, /target_link_options\(uci_arena_service_launcher PRIVATE \/Brepro\)/u);
});
