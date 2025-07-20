import { parseAsync, transformFromAstAsync, NodePath } from "@babel/core";
import * as babelTraverse from "@babel/traverse";
import { Identifier, toIdentifier, Node } from "@babel/types";
import { ResumeState, saveResumeState, loadResumeState, deleteResumeState } from "../../resume-utils.js";
import { verbose } from "../../verbose.js";

const traverse: typeof babelTraverse.default.default = (
  typeof babelTraverse.default === "function"
    ? babelTraverse.default
    : babelTraverse.default.default
) as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- This hack is because pkgroll fucks up the import somehow

type Visitor = (name: string, scope: string) => Promise<string>;
type BatchVisitor = (names: string[], scope: string) => Promise<Record<string, string>>;

function endWithNumber(name: string): boolean {
  return /\d$/.test(name);
}

function getSuffixNumber(name: string): number {
  const match = name.match(/(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}


function renameConflictIndentier(name: string): string {
  // 如果已经以下划线开头，则添加数字后缀
  if (name.startsWith('_')) {
    if (endWithNumber(name)) {
      const suffixNumber = getSuffixNumber(name);
      return name.replace(/(\d+)$/, (match) => (parseInt(match, 10) + 1).toString());
    }
    return `${name}1`;
  }
  // 否则添加下划线前缀
  return `_${name}`;
}

export async function batchVisitAllIdentifiers(
  code: string,
  visitor: Visitor,
  contextWindowSize: number,
  onProgress?: (percentageDone: number) => void,
  resume?: string,
  filePath?: string
): Promise<string> {
  let ast: Node | null;
  let renames: Set<string>;
  let visited: Set<string>;
  let scopes: NodePath<Identifier>[];
  let currentIndex = 0;

  const sessionId = resume;
  

  // Handle resume functionality - if codePath is provided, it implies resume
  if (sessionId) {
    const resumeState = await loadResumeState(sessionId);
    if (resumeState) {
      ast = await parseAsync(resumeState.code, { sourceType: "unambiguous" });
      if (!ast) {
        throw new Error("Failed to parse code");
      }
      renames = new Set(resumeState.renames);
      visited = new Set(resumeState.visited);
      scopes = await findScopes(ast);
      currentIndex = resumeState.currentIndex;
      
      console.log(`Resuming from index ${currentIndex}/${scopes.length}`);
    } else {
      // No resume state found, start fresh
      ast = await parseAsync(code, { sourceType: "unambiguous" });
      if (!ast) {
        throw new Error("Failed to parse code");
      }
      renames = new Set<string>();
      visited = new Set<string>();
      scopes = await findScopes(ast);
    }
  } else {
    // Fresh start
    ast = await parseAsync(code, { sourceType: "unambiguous" });
    if (!ast) {
      throw new Error("Failed to parse code");
    }
    renames = new Set<string>();
    visited = new Set<string>();
    scopes = await findScopes(ast);
  }

  const numRenamesExpected = scopes.length;

  // Process remaining scopes
  for (let i = currentIndex; i < scopes.length; i++) {
    const smallestScope = scopes[i];
    
    if (hasVisited(smallestScope, visited)) continue;

    const smallestScopeNode = smallestScope.node;
    if (smallestScopeNode.type !== "Identifier") {
      throw new Error("No identifiers found");
    }

    const surroundingCode = await scopeToString(
      smallestScope,
      contextWindowSize
    );
    const renamed = await visitor(smallestScopeNode.name, surroundingCode);
    if (renamed !== smallestScopeNode.name) {
      let safeRenamed = toIdentifier(renamed);
      while (
        renames.has(safeRenamed) ||
        smallestScope.scope.hasBinding(safeRenamed)
      ) {
        safeRenamed = renameConflictIndentier(safeRenamed);
      }
      renames.add(safeRenamed);

      smallestScope.scope.rename(smallestScopeNode.name, safeRenamed);
    }
    markVisited(smallestScope, smallestScopeNode.name, visited);

    // Save progress periodically
    if (sessionId && (i % 10 === 0 || i === scopes.length - 1)) {
      const newCodeResult = await transformFromAstAsync(ast);
      if (!newCodeResult || !newCodeResult.code) {
        throw new Error("Failed to stringify code");
      }
      

      const resumeState: ResumeState = {
        code: newCodeResult?.code,
        renames: Array.from(renames),
        visited: Array.from(visited),
        currentIndex: i + 1,
        totalScopes: scopes.length,
        codePath: resume || ""
      };
      await saveResumeState(resumeState, sessionId);
    }

    onProgress?.(visited.size / numRenamesExpected);
  }
  onProgress?.(1);

  // Clean up resume state when complete
  if (sessionId) {
    await deleteResumeState(sessionId);
  }

  const stringified = await transformFromAstAsync(ast);
  if (stringified?.code == null) {
    throw new Error("Failed to stringify code");
  }
  return stringified.code;
}

export async function batchVisitAllIdentifiersGrouped(
  code: string,
  visitor: BatchVisitor,
  contextWindowSize: number,
  onProgress?: (percentageDone: number) => void,
  resume?: string,
  maxBatchSize: number = 10,
  overlapThreshold: number = 0.7,
  filePath?: string
): Promise<string> {
  let ast: Node | null;
  let renames: Set<string>;
  let visited: Set<string>;
  let scopes: NodePath<Identifier>[];
  let currentIndex = 0;

  const sessionId = resume;
  
  // Handle resume functionality - if codePath is provided, it implies resume
  if (sessionId) {
    const resumeState = await loadResumeState(sessionId);
    if (resumeState) {
      ast = await parseAsync(resumeState.code, { sourceType: "unambiguous" });
      if (!ast) {
        throw new Error("Failed to parse code");
      }
      renames = new Set(resumeState.renames);
      visited = new Set(resumeState.visited);
      scopes = await findScopes(ast);
      currentIndex = resumeState.currentIndex;
      
      console.log(`Resuming from index ${currentIndex}/${scopes.length}`);
    } else {
      // No resume state found, start fresh
      ast = await parseAsync(code, { sourceType: "unambiguous" });
      if (!ast) {
        throw new Error("Failed to parse code");
      }
      renames = new Set<string>();
      visited = new Set<string>();
      scopes = await findScopes(ast);
    }
  } else {
    // Fresh start
    ast = await parseAsync(code, { sourceType: "unambiguous" });
    if (!ast) {
      throw new Error("Failed to parse code");
    }
    renames = new Set<string>();
    visited = new Set<string>();
    scopes = await findScopes(ast);
  }

  // 按位置先后找到scopes，然后按作用域分组，最后按作用域范围从小到大排序组
  const groupedScopes = groupByScopePosition(scopes);
  const sortedGroups = sortGroupsByScopeSize(groupedScopes);
  
  // 预计算总组数用于进度跟踪
  let totalGroups = 0;
  for (const group of sortedGroups) {
    const batchCount = Math.ceil(group.identifiers.length / maxBatchSize);
    totalGroups += batchCount;
  }
  
  let processedCount = 0;
  let groupIndex = 0;
  const groupGenerator = splitOversizedGroupsGenerator(sortedGroups, contextWindowSize, maxBatchSize);
  
  // Process groups in scope size order (smallest to largest)
  for await (const group of groupGenerator) {
    if (processedCount < currentIndex) {
      processedCount++;
      groupIndex++;
      continue;
    }
    
    // 检查是否已经处理过这个组中的所有identifier
    const unvisitedIdentifiers = group.identifiers.filter(id => !hasVisited(id, visited));
    if (unvisitedIdentifiers.length === 0) {
      processedCount++;
      groupIndex++;
      continue;
    }

    // 去重：确保每个变量名在批次中只出现一次
    const uniqueIdentifierNames = [...new Set(unvisitedIdentifiers.map(id => id.node.name))];
    const surroundingCode = group.surroundingCode;

    // 批量重命名这个组中的所有identifier
    const renameMap = await visitor(uniqueIdentifierNames, surroundingCode);
    
    // 应用重命名
    for (const identifier of unvisitedIdentifiers) {
      const originalName = identifier.node.name;
      const newName = renameMap[originalName];
      
      if (newName && newName !== originalName) {
        let safeRenamed = toIdentifier(newName);
        while (
          renames.has(safeRenamed) ||
          identifier.scope.hasBinding(safeRenamed)
        ) {
          safeRenamed = renameConflictIndentier(safeRenamed);
        }
        renames.add(safeRenamed);

        identifier.scope.rename(originalName, safeRenamed);
      }
      markVisited(identifier, originalName, visited);
    }

    processedCount++;
    groupIndex++;

    // Save progress periodically
    if (sessionId && (groupIndex % 5 === 0 || groupIndex === totalGroups)) {
      const newCodeResult = await transformFromAstAsync(ast);
      if (!newCodeResult || !newCodeResult.code) {
        throw new Error("Failed to stringify code");
      }
      
      const resumeState: ResumeState = {
        code: newCodeResult?.code,
        renames: Array.from(renames),
        visited: Array.from(visited),
        currentIndex: processedCount,
        totalScopes: totalGroups,
        codePath: resume || ""
      };
      await saveResumeState(resumeState, sessionId);
    }

    onProgress?.(groupIndex / totalGroups);
  }
  onProgress?.(1);

  // Clean up resume state when complete
  if (sessionId) {
    await deleteResumeState(sessionId);
  }

  const stringified = await transformFromAstAsync(ast);
  if (stringified?.code == null) {
    throw new Error("Failed to stringify code");
  }
  return stringified.code;
}

// 分离作用域查找和排序逻辑
function findScopes(ast: Node): NodePath<Identifier>[] {
  const scopes: NodePath<Identifier>[] = [];
  traverse(ast, {
    BindingIdentifier(path) {
      scopes.push(path);
    }
  });

  // 先按位置先后排序（文件中的出现顺序）
  scopes.sort((a, b) => {
    const aStart = a.node.start || 0;
    const bStart = b.node.start || 0;
    return aStart - bStart;
  });

  return scopes;
}

// 获取作用域范围大小用于排序
function getScopeSize(scope: NodePath<Identifier>): number {
  const bindingBlock = closestSurroundingContextPath(scope).scope.block;
  return bindingBlock.end! - bindingBlock.start!;
}

// 按作用域范围从小到大排序组
function sortGroupsByScopeSize(groups: Array<{ identifiers: NodePath<Identifier>[], scopeKey: string }>): Array<{ identifiers: NodePath<Identifier>[], scopeKey: string }> {
  return groups.sort((a, b) => {
    const sizeA = getScopeSize(a.identifiers[0]);
    const sizeB = getScopeSize(b.identifiers[0]);
    return sizeA - sizeB; // 从小到大排序
  });
}

function hasVisited(path: NodePath<Identifier>, visited: Set<string>) {
  return visited.has(path.node.name);
}

function markVisited(
  path: NodePath<Identifier>,
  newName: string,
  visited: Set<string>
) {
  visited.add(newName);
}

async function scopeToString(
  path: NodePath<Identifier>,
  contextWindowSize: number
): Promise<string> {
  const surroundingPath = closestSurroundingContextPath(path);
  
  // 获取代码字符串，但限制大小
  const codeStr = `${surroundingPath}`;
  const maxLen = Math.min(codeStr.length, contextWindowSize);
  
  // 直接返回切片后的字符串，避免中间大字符串
  return codeStr.slice(0, maxLen);
}

// 第一步：按作用域位置分组identifier
function groupByScopePosition(
  scopes: NodePath<Identifier>[]
): Array<{ identifiers: NodePath<Identifier>[], scopeKey: string }> {
  const scopeGroups = new Map<string, NodePath<Identifier>[]>();
  
  for (const scope of scopes) {
    const scopeKey = getScopePositionKey(scope);
    
    if (!scopeGroups.has(scopeKey)) {
      scopeGroups.set(scopeKey, []);
    }
    scopeGroups.get(scopeKey)!.push(scope);
  }
  
  return Array.from(scopeGroups.entries()).map(([scopeKey, identifiers]) => ({
    identifiers,
    scopeKey
  }));
}

// 第二步：将过大的组切分为多个批次（流式处理，减少内存占用）
async function* splitOversizedGroupsGenerator(
  groups: Array<{ identifiers: NodePath<Identifier>[], scopeKey: string }>,
  contextWindowSize: number,
  maxBatchSize: number = 10
): AsyncIterableIterator<{ identifiers: NodePath<Identifier>[], scopeKey: string, surroundingCode: string }> {
  for (const group of groups) {
    const { identifiers, scopeKey } = group;
    
    // 如果组大小未超过限制，直接生成
    if (identifiers.length <= maxBatchSize) {
      const surroundingCode = await scopeToString(identifiers[0], contextWindowSize);
      yield {
        identifiers,
        scopeKey,
        surroundingCode
      };
    } else {
      // 超过批次大小，按批次流式生成
      for (let i = 0; i < identifiers.length; i += maxBatchSize) {
        const batchIdentifiers = identifiers.slice(i, i + maxBatchSize);
        const surroundingCode = await scopeToString(batchIdentifiers[0], contextWindowSize);
        yield {
          identifiers: batchIdentifiers,
          scopeKey: `${scopeKey}_${i}`,
          surroundingCode
        };
      }
    }
  }
}

// 同步版本的splitOversizedGroups用于旧的groupIdentifiersByScope
async function splitOversizedGroups(
  groups: Array<{ identifiers: NodePath<Identifier>[], scopeKey: string }>,
  contextWindowSize: number,
  maxBatchSize: number = 10
): Promise<Array<{ identifiers: NodePath<Identifier>[], scopeKey: string, surroundingCode: string }>> {
  const result: Array<{ identifiers: NodePath<Identifier>[], scopeKey: string, surroundingCode: string }> = [];
  
  for (const group of groups) {
    const { identifiers, scopeKey } = group;
    
    if (identifiers.length <= maxBatchSize) {
      const surroundingCode = await scopeToString(identifiers[0], contextWindowSize);
      result.push({
        identifiers,
        scopeKey,
        surroundingCode
      });
    } else {
      for (let i = 0; i < identifiers.length; i += maxBatchSize) {
        const batchIdentifiers = identifiers.slice(i, i + maxBatchSize);
        const surroundingCode = await scopeToString(batchIdentifiers[0], contextWindowSize);
        result.push({
          identifiers: batchIdentifiers,
          scopeKey: `${scopeKey}_${i}`,
          surroundingCode
        });
      }
    }
  }
  
  return result;
}

// 完整的分组函数：两步实现
async function groupIdentifiersByScope(
  scopes: NodePath<Identifier>[],
  contextWindowSize: number,
  maxBatchSize: number = 10
): Promise<Array<{ identifiers: NodePath<Identifier>[], scopeKey: string, surroundingCode: string }>> {
  // 第一步：按作用域位置分组
  const grouped = groupByScopePosition(scopes);
  
  // 第二步：切分过大的组
  return await splitOversizedGroups(grouped, contextWindowSize, maxBatchSize);
}


// 获取作用域的位置key，避免存储完整代码
function getScopePositionKey(scope: NodePath<Identifier>): string {
  const contextPath = closestSurroundingContextPath(scope);
  const node = contextPath.node;
  
  if (node.loc) {
    return `${node.type}_${node.loc.start.line}_${node.loc.start.column}`;
  }
  
  // 如果没有位置信息，使用节点类型和哈希
  return `${node.type}_${node.start || 0}`;
}

function closestSurroundingContextPath(
  path: NodePath<Identifier>
): NodePath<Node> {
  const programOrBindingNode = path.findParent(
    (p) => p.isProgram() || path.node.name in p.getOuterBindingIdentifiers()
  )?.scope.path;
  return programOrBindingNode ?? path.scope.path;
}
