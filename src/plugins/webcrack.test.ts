import assert from "assert";
import fs from "fs/promises";
import os from "os";
import path from "path";
import test from "node:test";
import { findJavaScriptFiles } from "./webcrack.js";

test("findJavaScriptFiles recursively collects .js files", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "humanify-webcrack-"));
  const nestedDir = path.join(tempDir, "nested");
  const deepDir = path.join(nestedDir, "deep");

  await fs.mkdir(deepDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(tempDir, "root.js"), "console.log('root');"),
    fs.writeFile(path.join(tempDir, "skip.txt"), "text"),
    fs.writeFile(path.join(nestedDir, "nested.js"), "console.log('nested');"),
    fs.writeFile(path.join(deepDir, "deep.js"), "console.log('deep');")
  ]);

  try {
    const files = await findJavaScriptFiles(tempDir);
    assert.deepEqual(
      files.map((file) => file.path),
      [
        path.join(deepDir, "deep.js"),
        path.join(nestedDir, "nested.js"),
        path.join(tempDir, "root.js")
      ]
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
