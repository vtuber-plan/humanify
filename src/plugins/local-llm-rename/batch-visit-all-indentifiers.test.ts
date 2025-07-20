import assert from "assert";
import test from "node:test";
import { batchVisitAllIdentifiersGrouped } from "./batch-visit-all-indentifiers.js";

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
  
  // 第一个组应该包含processData函数中的变量
  const firstGroup = batchResults[0];
  assert.ok(firstGroup.names.includes("a") || firstGroup.names.includes("b") || firstGroup.names.includes("c"), 
    "First group should contain variables from processData function");
  
  // 第二个组应该包含calculateSum函数中的变量
  const secondGroup = batchResults[1];
  assert.ok(secondGroup.names.includes("x") || secondGroup.names.includes("y"), 
    "Second group should contain variables from calculateSum function");
});

test("handles single identifier in scope", async () => {
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
  
  // 检查是否有单变量组
  const singleVarGroups = batchResults.filter(group => group.names.length === 1);
  assert.ok(singleVarGroups.length > 0, "Should have groups with single variables");
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

  // 验证结果：X1应该只出现一次
  const x1Count = processedNames.filter(name => name === 'X1').length;
  assert.strictEqual(x1Count, 1, "X1 should only appear once in the batch");
  
  // 验证所有变量都被处理了
  assert.ok(processedNames.includes('X1'), "X1 should be processed");
  assert.ok(processedNames.includes('G0'), "G0 should be processed");
  assert.ok(processedNames.includes('J'), "J should be processed");
  
  // 验证没有重复的变量名
  const uniqueNames = [...new Set(processedNames)];
  assert.strictEqual(uniqueNames.length, processedNames.length, "No duplicate names should be sent to LLM");
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