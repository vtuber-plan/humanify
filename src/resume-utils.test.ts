import assert from "assert";
import path from "path";
import test from "node:test";
import { resolveResumeSessionPath, resolveResumeStatePath } from "./resume-utils.js";

test("resolveResumeSessionPath should match legacy path when filePath is absent", () => {
  const resumePath = path.join(process.cwd(), "fixtures", "bundle.js");
  assert.equal(
    resolveResumeSessionPath(resumePath),
    resolveResumeStatePath(resumePath)
  );
});

test("resolveResumeSessionPath should isolate sessions by filePath", () => {
  const resumePath = path.join(process.cwd(), "fixtures", "bundle.js");
  const filePathA = path.join(process.cwd(), "fixtures", "chunks", "a.js");
  const filePathB = path.join(process.cwd(), "fixtures", "chunks", "b.js");

  const sessionA = resolveResumeSessionPath(resumePath, filePathA);
  const sessionB = resolveResumeSessionPath(resumePath, filePathB);

  assert.notEqual(sessionA, sessionB);
  assert.equal(sessionA, resolveResumeSessionPath(resumePath, filePathA));
  assert.equal(sessionB, resolveResumeSessionPath(resumePath, filePathB));
});
