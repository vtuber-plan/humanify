import assert from "assert";
import fs from "fs/promises";
import os from "os";
import path from "path";
import test from "node:test";
import { batchVisitAllIdentifiersGrouped } from "./batch-visit-all-indentifiers.js";
import { resolveResumeStatePath } from "../../resume-utils.js";

test("groups identifiers by surrounding scope", async () => {
  const code = `
function processData() {
  const a = 1;
  const b = 2;
  const c = a + b;
  return c;
}

function calculateSum() {
  const x = 10;
  const y = 20;
  return x + y;
}
  `.trim();

  const batchResults: Array<{ names: string[], scope: string }> = [];
  await batchVisitAllIdentifiersGrouped(
    code,
    async (names, scope) => {
      batchResults.push({ names, scope });
      // 返回一个简单的重命名映射
      const renameMap: Record<string, string> = {};
      names.forEach((name, index) => {
        renameMap[name] = `${name}_renamed_${index}`;
      });
      return renameMap;
    },
    200
  );

  // 验证分组结果
  assert.strictEqual(batchResults.length, 2, "Should have 2 groups");
  
  const groupNames = batchResults.map(group => group.names);
  assert.ok(
    groupNames.some(names => names.includes("a") || names.includes("b") || names.includes("c")),
    "One group should contain variables from processData function"
  );
  assert.ok(
    groupNames.some(names => names.includes("x") || names.includes("y")),
    "One group should contain variables from calculateSum function"
  );
});

test("handles single identifier bindings even when small scopes may be auto-merged", async () => {
  const code = `
const globalVar = 42;
function test() {
  const localVar = 123;
}
  `.trim();

  const batchResults: Array<{ names: string[], scope: string }> = [];
  await batchVisitAllIdentifiersGrouped(
    code,
    async (names, scope) => {
      batchResults.push({ names, scope });
      const renameMap: Record<string, string> = {};
      names.forEach((name, index) => {
        renameMap[name] = `${name}_renamed_${index}`;
      });
      return renameMap;
    },
    200
  );

  // 验证结果
  assert.ok(batchResults.length > 0, "Should have at least one group");
  const allNames = batchResults.flatMap((group) => group.names);
  assert.ok(allNames.includes("globalVar"), "globalVar should be processed");
  assert.ok(allNames.includes("localVar"), "localVar should be processed");
});

test("applies batch renames correctly", async () => {
  const code = `
function example() {
  const a = 1;
  const b = 2;
  const result = a + b;
  return result;
}
  `.trim();

  const result = await batchVisitAllIdentifiersGrouped(
    code,
    async (names, scope) => {
      // 返回预定义的重命名映射
      return {
        "a": "firstNumber",
        "b": "secondNumber", 
        "result": "sum"
      };
    },
    200
  );

  // 验证重命名结果
  assert.ok(result.includes("firstNumber"), "Should contain renamed variable 'firstNumber'");
  assert.ok(result.includes("secondNumber"), "Should contain renamed variable 'secondNumber'");
  assert.ok(result.includes("sum"), "Should contain renamed variable 'sum'");
  assert.ok(!result.includes("const a ="), "Should not contain original variable 'a'");
  assert.ok(!result.includes("const b ="), "Should not contain original variable 'b'");
  assert.ok(!result.includes("const result ="), "Should not contain original variable 'result'");
}); 

test("handles duplicate variable names in batch", async () => {
  const code = `
function test() {
  const X1 = 1;
  const G0 = 2;
  const J = 4;
}

function anotherTest() {
  const X1 = 3; // 不同作用域中的同名变量
  const K = 5;
}
  `.trim();

  const processedNames: string[] = [];
  await batchVisitAllIdentifiersGrouped(
    code,
    async (names, scope) => {
      // 记录传递给LLM的变量名
      processedNames.push(...names);
      
      // 返回一个简单的重命名映射
      const renameMap: Record<string, string> = {};
      names.forEach((name, index) => {
        renameMap[name] = `${name}_renamed_${index}`;
      });
      return renameMap;
    },
    200
  );

  // 同名变量在不同作用域应分别处理，避免语义串扰
  const x1Count = processedNames.filter(name => name === 'X1').length;
  assert.strictEqual(x1Count, 2, "X1 should be processed separately in each scope");
  
  // 验证所有变量都被处理了
  assert.ok(processedNames.includes('X1'), "X1 should be processed");
  assert.ok(processedNames.includes('G0'), "G0 should be processed");
  assert.ok(processedNames.includes('J'), "J should be processed");
  
  // 跨作用域允许同名变量重复发送（例如 X1）
  const uniqueNames = [...new Set(processedNames)];
  assert.ok(uniqueNames.length < processedNames.length, "Cross-scope duplicate names should be allowed");
});

test("handles multiple references to same variable in batch", async () => {
  const code = `
function test() {
  const X1 = 1;
  const G0 = 2;
  const J = 4;
  
  // 多次引用同一个变量
  console.log(X1);
  const result = X1 + G0;
  return X1 * J;
}
  `.trim();

  const processedNames: string[] = [];
  await batchVisitAllIdentifiersGrouped(
    code,
    async (names, scope) => {
      // 记录传递给LLM的变量名
      processedNames.push(...names);
      
      // 返回一个简单的重命名映射
      const renameMap: Record<string, string> = {};
      names.forEach((name, index) => {
        renameMap[name] = `${name}_renamed_${index}`;
      });
      return renameMap;
    },
    200
  );

  // 验证结果：每个变量名应该只出现一次
  const x1Count = processedNames.filter(name => name === 'X1').length;
  const g0Count = processedNames.filter(name => name === 'G0').length;
  const jCount = processedNames.filter(name => name === 'J').length;
  
  assert.strictEqual(x1Count, 1, "X1 should only appear once in the batch");
  assert.strictEqual(g0Count, 1, "G0 should only appear once in the batch");
  assert.strictEqual(jCount, 1, "J should only appear once in the batch");
  
  // 验证没有重复的变量名
  const uniqueNames = [...new Set(processedNames)];
  assert.strictEqual(uniqueNames.length, processedNames.length, "No duplicate names should be sent to LLM");
}); 

test("keeps function params and local vars in one batch despite repeated assignments", async () => {
  const code = `
const handler = function (N = 1) {
  if (this[$5[1537]]) {
    var M;
    var g = this[$R[1657]];
    var C = this[$5[1539]];
    var z = 0;
    var R = g[$c[5]];
    var s = 0;
    var e = this[$R[1658]];
    for (z = R - 1; z > -1; z--) {
      M = g[z];
      s = e[M.id];
      if (s >= M[$c[1515]]) {
        s = 0;
        g[$R[64]](z, 1);
        C.push(M);
      } else {
        s += 1;
      }
      e[M.id] = s;
    }
  }
};
  `.trim();

  const targetNames = ["N", "M", "g", "C", "z", "R", "s", "e"];
  const batchResults: string[][] = [];
  await batchVisitAllIdentifiersGrouped(
    code,
    async (names) => {
      batchResults.push(names);
      const renameMap: Record<string, string> = {};
      names.forEach((name) => {
        renameMap[name] = name;
      });
      return renameMap;
    },
    2000,
    undefined,
    undefined,
    20
  );

  const targetBatch = batchResults.find((names) =>
    targetNames.every((name) => names.includes(name))
  );
  assert.ok(targetBatch, "Expected a single batch containing N/M/g/C/z/R/s/e");

  const processedNames = batchResults.flat();
  for (const name of targetNames) {
    const count = processedNames.filter((n) => n === name).length;
    assert.strictEqual(count, 1, `${name} should be processed exactly once`);
  }
});

test("splits by maxBatchSize only after declaration-level dedup", async () => {
  const code = `
const fn = function (a, b, c, d) {
  a++;
  b++;
  c++;
  d++;
};
  `.trim();

  const batchResults: string[][] = [];
  await batchVisitAllIdentifiersGrouped(
    code,
    async (names) => {
      batchResults.push(names);
      const renameMap: Record<string, string> = {};
      names.forEach((name) => {
        renameMap[name] = name;
      });
      return renameMap;
    },
    500,
    undefined,
    undefined,
    2
  );

  const argNames = ["a", "b", "c", "d"];
  const argBatches = batchResults.filter((names) => names.some((name) => argNames.includes(name)));
  assert.strictEqual(argBatches.length, 2, "Expected parameter group to split into exactly 2 batches");

  const processedArgNames = argBatches.flat().sort();
  assert.deepStrictEqual(processedArgNames, argNames.sort());
});

test("throws clear error when batch size is non-positive", async () => {
  const code = `const a = 1;`;

  await assert.rejects(
    async () => {
      await batchVisitAllIdentifiersGrouped(
        code,
        async () => ({}),
        200,
        undefined,
        undefined,
        0
      );
    },
    /Invalid batch size: 0/
  );
});

test("throws clear error when batch concurrency is non-positive", async () => {
  const code = `const a = 1;`;

  await assert.rejects(
    async () => {
      await batchVisitAllIdentifiersGrouped(
        code,
        async () => ({}),
        200,
        undefined,
        undefined,
        10,
        undefined,
        16,
        false,
        0
      );
    },
    /Invalid batch concurrency: 0/
  );
});

test("throws clear error when small scope merge limit is negative", async () => {
  const code = `const a = 1;`;

  await assert.rejects(
    async () => {
      await batchVisitAllIdentifiersGrouped(
        code,
        async () => ({}),
        200,
        undefined,
        undefined,
        10,
        undefined,
        16,
        false,
        1,
        50,
        -1
      );
    },
    /Invalid small scope merge limit: -1/
  );
});

test("supports concurrent batch visitor calls while keeping deterministic apply order", async () => {
  const code = `
function one(){ const a = 1; return a; }
function two(){ const b = 2; return b; }
function three(){ const c = 3; return c; }
function four(){ const d = 4; return d; }
  `.trim();

  let inFlight = 0;
  let maxInFlight = 0;

  const result = await batchVisitAllIdentifiersGrouped(
    code,
    async (names) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;

      const renameMap: Record<string, string> = {};
      names.forEach((name) => {
        renameMap[name] = `${name}_renamed`;
      });
      return renameMap;
    },
    400,
    undefined,
    undefined,
    1,
    undefined,
    16,
    false,
    3
  );

  assert.ok(maxInFlight >= 2, `Expected concurrent calls, got maxInFlight=${maxInFlight}`);
  assert.ok(result.includes("aRenamed") || result.includes("a_renamed"), "Expected renamed output to be applied");
});

test("auto-merges tiny same-boundary batches to reduce LLM calls", async () => {
  const code = `
function one() {
  { const a = 1; console.log(a); }
  { const b = 2; console.log(b); }
  { const c = 3; console.log(c); }
}
  `.trim();

  let callsWithoutMerge = 0;
  await batchVisitAllIdentifiersGrouped(
    code,
    async (names) => {
      callsWithoutMerge++;
      const renameMap: Record<string, string> = {};
      names.forEach((name) => {
        renameMap[name] = name;
      });
      return renameMap;
    },
    500,
    undefined,
    undefined,
    10,
    undefined,
    16,
    false,
    1,
    50,
    0
  );

  let callsWithMerge = 0;
  await batchVisitAllIdentifiersGrouped(
    code,
    async (names) => {
      callsWithMerge++;
      const renameMap: Record<string, string> = {};
      names.forEach((name) => {
        renameMap[name] = name;
      });
      return renameMap;
    },
    500
  );

  assert.ok(
    callsWithMerge < callsWithoutMerge,
    `Expected fewer calls after merge. before=${callsWithoutMerge}, after=${callsWithMerge}`
  );
});

test("does not merge tiny scopes across different function boundaries", async () => {
  const code = `
function one() { const a = 1; return a; }
function two() { const b = 2; return b; }
  `.trim();

  let llmCalls = 0;
  await batchVisitAllIdentifiersGrouped(
    code,
    async (names) => {
      llmCalls++;
      const renameMap: Record<string, string> = {};
      names.forEach((name) => {
        renameMap[name] = name;
      });
      return renameMap;
    },
    500,
    undefined,
    undefined,
    10,
    undefined,
    16,
    false,
    1,
    50,
    2
  );

  assert.ok(llmCalls >= 2, `Expected separate calls across function boundaries, got ${llmCalls}`);
});

test("skips empty catch params instead of sending them to LLM", async () => {
  const code = `
function wrapper() {
  try {
    runTask();
  } catch (z) {}
  const N = createConn();
  return N;
}
  `.trim();

  const seenNames: string[] = [];
  await batchVisitAllIdentifiersGrouped(
    code,
    async (names) => {
      seenNames.push(...names);
      const renameMap: Record<string, string> = {};
      names.forEach((name) => {
        renameMap[name] = name;
      });
      return renameMap;
    },
    500
  );

  assert.ok(seenNames.includes("N"), "Expected regular identifier to be processed");
  assert.ok(!seenNames.includes("z"), "Expected empty catch param to be skipped");
});

test("expands short single-identifier context upward to improve signal", async () => {
  const code = `
const init = () => {};
const holder = {};
holder.setUrl = function (N) { this._url = N; };
const alpha = 1;
const beta = 2;
const gamma = alpha + beta;
function helperOne() {
  const t = 1;
  return t + gamma;
}
function helperTwo() {
  const q = 2;
  return q + gamma;
}
  `.trim();

  let capturedContext = "";
  await batchVisitAllIdentifiersGrouped(
    code,
    async (names, scope) => {
      if (names.includes("N")) {
        capturedContext = scope;
      }
      const renameMap: Record<string, string> = {};
      names.forEach((name) => {
        renameMap[name] = name;
      });
      return renameMap;
    },
    900,
    undefined,
    undefined,
    1,
    undefined,
    12,
    false,
    1,
    50,
    0
  );

  assert.ok(capturedContext.includes("this._url = N"), "Captured context should include target usage");
  assert.ok(
    capturedContext.split("\n").length >= 12,
    `Expected expanded context to have at least 12 lines. actual=${capturedContext.split("\n").length}`
  );
});

test("batch resume path should never overwrite or delete the original code file", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "humanify-batch-resume-"));
  const resumeTarget = path.join(tempDir, "resume-target.js");
  const originalContent = "const untouched = 1;\n";
  const sidecarPath = resolveResumeStatePath(resumeTarget);
  await fs.writeFile(resumeTarget, originalContent, "utf8");

  try {
    await batchVisitAllIdentifiersGrouped(
      "const a = 1;",
      async () => ({}),
      200,
      undefined,
      resumeTarget
    );

    const targetExists = await fs.stat(resumeTarget).then(() => true).catch(() => false);
    assert.equal(targetExists, true);
    assert.equal(await fs.readFile(resumeTarget, "utf8"), originalContent);

    const sidecarExists = await fs.stat(sidecarPath).then(() => true).catch(() => false);
    assert.equal(sidecarExists, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
