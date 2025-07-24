import { parseAsync, transformFromAstAsync, NodePath } from "@babel/core";
import * as babelTraverse from "@babel/traverse";
import { Identifier, toIdentifier, Node, identifier, cloneNode } from "@babel/types";
import { ResumeState, saveResumeState, loadResumeState, deleteResumeState } from "../../resume-utils.js";
import { verbose } from "../../verbose.js";
import { calculateScopeInformationScoreAST } from "../../readability-utils.js";

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

export async function batchVisitAllIdentifiersGrouped(
  code: string,
  visitor: BatchVisitor,
  contextWindowSize: number,
  onProgress?: (percentageDone: number) => void,
  resume?: string,
  maxBatchSize: number = 10,
  filePath?: string,
  minInformationScore: number = 16
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
  verbose.log(`Finding scopes...`);
  const groupedScopes = groupByScopePosition(scopes);
  verbose.log(`Grouping scopes...`);
  const sortedGroups = sortGroupsByScopeSize(groupedScopes);
  verbose.log(`Sorting groups...`);

  // 预计算总组数用于进度跟踪
  let totalGroups = 0;
  for (const group of sortedGroups) {
    const batchCount = Math.ceil(group.identifiers.length / maxBatchSize);
    totalGroups += batchCount;
  }
  verbose.log("Counting total groups...");

  let processedCount = 0;
  let groupIndex = 0;
  const groupGenerator = await splitOversizedGroupsGenerator(sortedGroups, contextWindowSize, maxBatchSize, minInformationScore);
  verbose.log(`Processing groups...`);

  // Process groups in scope size order (smallest to largest)
  for await (const group of groupGenerator) {
    if (processedCount < currentIndex) {
      processedCount++;
      groupIndex++;
      continue;
    }

    // 检查
    const unvisitedIdentifiers = group.identifiers;
    if (unvisitedIdentifiers.length === 0) {
      processedCount++;
      groupIndex++;
      continue;
    }

    const identifierNames = unvisitedIdentifiers.map(id => id.node.name);
    const surroundingCode = group.surroundingCode;

    // 批量重命名这个组中的所有identifier
    const renameMap = await visitor(identifierNames, surroundingCode);

    // 应用重命名
    for (const identifier of unvisitedIdentifiers) {
      const originalName = identifier.node.name;
      // 不包含key originalName
      if (!renameMap.hasOwnProperty(originalName)) {
        continue;
      }
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
        verbose.log(`Renamed ${originalName} to ${safeRenamed}`);
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

/**
 * 使用AST检查作用域信息是否足够，如果不足则向上扩展作用域
 * 并在特定变量后面添加注释提示模型
 * @param path 当前作用域的标识符路径
 * @param contextWindowSize 上下文窗口大小限制
 * @param minInformationScore 最小信息量阈值
 * @param identifiers 需要重命名的标识符列表，用于添加注释
 * @returns 扩展后的作用域代码，包含注释提示
 */
async function expandScopeIfInsufficientAST(
  path: NodePath<Identifier>,
  minInformationScore: number = 16,
  identifiers: NodePath<Identifier>[] = []
): Promise<string> {
  let currentPath = closestSurroundingContextPath(path);

  // Add comment
  for (const identifier of identifiers) {
    identifier.addComment("trailing", `Rename this ${identifier.node.name}`, false);
  }

  let currentCode = `${currentPath}`;
  const identifierNames = identifiers.map(id => id.node.name);

  // 尝试当前作用域
  const currentAst = currentPath;
  if (currentAst) {
    // const analysisScore = calculateScopeInformationScoreAST(currentAst);
    const analysisScore = currentCode.split("\n").length;
    if (analysisScore >= minInformationScore) {
      // 添加注释到指定变量
      // restore identifiers
      for (const identifier of identifiers) {
        identifier.node.trailingComments = [];
      }
      return currentCode;
    }
  }

  // 信息不足，向上扩展作用域
  let parentPath = currentPath.parentPath;

  while (parentPath && !parentPath.isProgram()) {
    const parentCode = `${parentPath}`;
    const parentAst = parentPath;

    if (parentAst) {
      // const analysisScore = calculateScopeInformationScoreAST(parentPath);
      const analysisScore = currentCode.split("\n").length;
      if (analysisScore >= minInformationScore) {
        // 添加注释到指定变量
        // restore identifiers
        for (const identifier of identifiers) {
          identifier.node.trailingComments = [];
        }
        return parentCode;
      }
    }

    parentPath = parentPath.parentPath;
  }

  // 如果到达全局作用域或信息仍然不足，返回原始作用域并添加注释
  // restore identifiers
  for (const identifier of identifiers) {
    identifier.node.trailingComments = [];
  }
  return currentCode;
}

function expandScope(surroundingScope: NodePath<Node>, minInformationScore: number = 16): NodePath<Node> {
    const currentAst = surroundingScope;
    if (currentAst) {
      // const analysisScore = calculateScopeInformationScoreAST(currentAst);
      const analysisScore = `${currentAst}`.split("\n").length;
      if (analysisScore >= minInformationScore) {
        return currentAst;
      }
    }

    if (!currentAst.parentPath) {
      return currentAst;
    }

    // 信息不足，向上扩展作用域
    let parentPath = currentAst.parentPath;

    while (parentPath && !parentPath.isProgram()) {
      if (parentPath) {
        // const analysisScore = calculateScopeInformationScoreAST(parentPath);
        const analysisScore = `${parentPath}`.split("\n").length;
        if (analysisScore >= minInformationScore) {
          return parentPath;
        }
      }

      if (!parentPath.parentPath) {
        break;
      }
      parentPath = parentPath.parentPath;
    }
    return parentPath;
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
) {
  let surroundingPath = closestSurroundingContextPath(path);

  // 如果 surroundingPath 是匿名函数，再往上一层
  while (
    (surroundingPath.isFunctionExpression?.() || surroundingPath.isArrowFunctionExpression?.()) &&
    // @ts-ignore
    !surroundingPath.node.id // 没有 id 即为匿名函数
  ) {
    if (!surroundingPath.parentPath) break;
    surroundingPath = surroundingPath.parentPath;
  }

  const code = `${surroundingPath}`; // Implements a hidden `.toString()`
  if (code.length < contextWindowSize) {
    return code;
  }
  if (surroundingPath.isProgram()) {
    const pathCode = `${path}`;
    if (pathCode.length < contextWindowSize) {
      return pathCode;
    }
    return pathCode.slice(0, contextWindowSize);
  } else {
    return code.slice(0, contextWindowSize);
  }
}

async function scopesToString(
  path: NodePath<Identifier>,
  contextWindowSize: number,
  identifiers: NodePath<Identifier>[],
  minlines: number = 16
): Promise<string> {
  // 使用AST检查信息量并扩展作用域，添加注释到指定变量
  const code = await expandScopeIfInsufficientAST(path, minlines, identifiers);
  if (code.length > contextWindowSize) {
    var finalCode = "";
    for (const identifier of identifiers) {
      if (code.includes(identifier.node.name)) {
        continue;
      }
      identifier.addComment("trailing", `Rename this ${identifier.node.name}`, false);
      finalCode += `//========================Code Snippet for ${identifier.node.name}========================\n`;
      finalCode += await scopeToString(identifier, Math.floor(contextWindowSize / identifiers.length));
      finalCode += `\n...\n`;
      identifier.node.trailingComments = [];
    }

    if (finalCode.length > contextWindowSize) {
      finalCode = finalCode.slice(0, contextWindowSize);
    } else {
      finalCode = code.slice(0, contextWindowSize - finalCode.length) + finalCode;
    }

    return finalCode;
  } else {
    var finalCode = "";
    for (const identifier of identifiers) {
      if (code.includes(identifier.node.name)) {
        continue;
      }
      identifier.addComment("trailing", `Rename this ${identifier.node.name}`, false);
      finalCode += `//========================Code Snippet for ${identifier.node.name}========================\n`;
      finalCode += await scopeToString(identifier, Math.floor(contextWindowSize / identifiers.length));
      finalCode += `\n...\n`;
      identifier.node.trailingComments = [];
    }

    if (finalCode.length > contextWindowSize) {
      finalCode = finalCode.slice(0, contextWindowSize);
    } else {
      finalCode = code.slice(0, contextWindowSize - finalCode.length) + `\n...\n` + finalCode;
    }

    return finalCode;
  }
}

// 第一步：按作用域位置分组identifier
function groupByScopePosition(
  scopes: NodePath<Identifier>[]
): Array<{ identifiers: NodePath<Identifier>[], scopeKey: string }> {
  const scopeGroups = new Map<string, NodePath<Identifier>[]>();

  for (const scope of scopes) {
    var surroundingScope = expandScope(scope, 30);
    const scopeKey = getScopePositionKey(surroundingScope as NodePath<Identifier>);

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
  maxBatchSize: number = 10,
  minInformationScore: number = 16
): AsyncIterableIterator<{ identifiers: NodePath<Identifier>[], scopeKey: string, surroundingCode: string }> {
  for (const group of groups) {
    const { identifiers, scopeKey } = group;

    var identifiersList = [];
    for (var i = 0; i < identifiers.length; i++) {
      const identifier = identifiers[i];
      if (identifiersList.length >= maxBatchSize || identifiersList.map(id => id.node.name).indexOf(identifier.node.name) != -1) {
        const firstScope = identifiersList[0];
        const surroundingCode = await scopesToString(firstScope, contextWindowSize, identifiersList, minInformationScore);
        yield {
          identifiers: identifiersList,
          scopeKey: `${scopeKey}_${i}`,
          surroundingCode
        };
        identifiersList = [];
      }
      identifiersList.push(identifier);
    }
  }
}

// 同步版本的splitOversizedGroups用于旧的groupIdentifiersByScope
async function splitOversizedGroups(
  groups: Array<{ identifiers: NodePath<Identifier>[], scopeKey: string }>,
  contextWindowSize: number,
  maxBatchSize: number = 10,
  minlines: number = 16
): Promise<Array<{ identifiers: NodePath<Identifier>[], scopeKey: string, surroundingCode: string }>> {
  const result: Array<{ identifiers: NodePath<Identifier>[], scopeKey: string, surroundingCode: string }> = [];

  for (const group of groups) {
    const { identifiers, scopeKey } = group;

    if (identifiers.length <= maxBatchSize) {
      const firstScope = identifiers[0];
      const surroundingCode = await scopesToString(firstScope, contextWindowSize, identifiers, minlines);
      result.push({
        identifiers,
        scopeKey,
        surroundingCode
      });
    } else {
      for (let i = 0; i < identifiers.length; i += maxBatchSize) {
        const batchIdentifiers = identifiers.slice(i, i + maxBatchSize);
        const firstScope = batchIdentifiers[0];
        const surroundingCode = await scopesToString(firstScope, contextWindowSize, batchIdentifiers, minlines);
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
  maxBatchSize: number = 10,
  minInformationScore: number = 16
): Promise<Array<{ identifiers: NodePath<Identifier>[], scopeKey: string, surroundingCode: string }>> {
  // 第一步：按作用域位置分组
  const grouped = groupByScopePosition(scopes);

  // 第二步：切分过大的组
  return await splitOversizedGroups(grouped, contextWindowSize, maxBatchSize, minInformationScore);
}


// 获取作用域的位置key，避免存储完整代码
function getScopePositionKey(scope: NodePath<Identifier>): string {
  const contextPath = closestSurroundingContextPath(scope);
  const node = contextPath.node;

  if (node.loc) {
    return `${node.type}_${node.loc.start.line}_${node.loc.start.column}_${node.loc.end.line}_${node.loc.end.column}`;
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
