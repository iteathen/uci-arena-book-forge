import assert from "node:assert/strict";
import test from "node:test";

import { canonicalVendorBytes } from "../tools/verify-vendor-lock.mjs";

test("vendor lock canonicalizes text line endings without rewriting binary bytes", () => {
  assert.deepEqual(
    canonicalVendorBytes("src/runtime.mjs", Buffer.from("one\r\ntwo\r\n")),
    Buffer.from("one\ntwo\n"),
  );
  assert.deepEqual(
    canonicalVendorBytes("native/CMakeLists.txt", Buffer.from("one\r\ntwo\r\n")),
    Buffer.from("one\ntwo\n"),
  );
  assert.deepEqual(
    canonicalVendorBytes("native/process_instance_query.hpp", Buffer.from("one\r\ntwo\r\n")),
    Buffer.from("one\ntwo\n"),
  );
  const binary = Buffer.from([0, 13, 10, 255]);
  assert.strictEqual(canonicalVendorBytes("bin/runtime.dat", binary), binary);
});
