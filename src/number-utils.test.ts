import assert from "assert";
import test from "node:test";
import { parseNumber, parsePositiveNumber } from "./number-utils.js";

test("parseNumber parses valid integers", () => {
  assert.equal(parseNumber("10"), 10);
});

test("parsePositiveNumber rejects zero and negative values", () => {
  assert.throws(() => parsePositiveNumber("0", "batchSize"), /greater than 0/);
  assert.throws(() => parsePositiveNumber("-1", "batchSize"), /greater than 0/);
});
