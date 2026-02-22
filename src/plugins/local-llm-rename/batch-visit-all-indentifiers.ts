import { parseAsync, transformFromAstAsync, NodePath } from "@babel/core";
import * as babelTraverse from "@babel/traverse";
import { Identifier, toIdentifier, Node, identifier, cloneNode } from "@babel/types";
import * as babelGenerator from "@babel/generator";
import {
  ResumeState,
  saveResumeState,
  loadResumeState,
  deleteResumeState,
  resolveResumeStatePath,
  resolveResumeSessionPath
} from "../../resume-utils.js";
import { verbose } from "../../verbose.js";

const WEB_API_NAMES_LIST = [
  'Headers',
  'Set',
  'Map',
  'FormData',
  'URL',
  'URLSearchParams',
  'Blob',
  'TextEncoder',
  'TextDecoder',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'Response',
  'Request',
  'ArrayBuffer',
  'DataView',
  'Uint8Array',
  'Uint16Array',
  'Uint32Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'Promise',
  'fetch' // 注意：fetch在较新Node.js版本中为全局可用
];

const traverse: typeof babelTraverse.default.default = (
  typeof babelTraverse.default === "function"
    ? babelTraverse.default
    : babelTraverse.default.default
) as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- This hack is because pkgroll fucks up the import somehow

const generate: typeof babelGenerator.default.default = (
  typeof babelGenerator.default === "function"
    ? babelGenerator.default
    : babelGenerator.default.default
) as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Same hack for generator

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
  if (endWithNumber(name)) {
    const suffixNumber = getSuffixNumber(name);
    return name.replace(/(\d+)$/, (match) => (parseInt(match, 10) + 1).toString());
  }
  return `${name}1`;
}

export async function batchVisitAllIdentifiersGrouped(
  code: string,
  visitor: BatchVisitor,
  contextWindowSize: number,
  onProgress?: (percentageDone: number) => void,
  resume?: string,
  maxBatchSize: number = 10,
  filePath?: string,
  minInformationScore: number = 16,
  uniqueNames = false,
  batchConcurrency: number = 1,
  dirtyCheckpointInterval: number = 50,
  smallScopeMergeLimit: number = 2
): Promise<string> {
  let ast: Node | null;
  let renames: Set<string>;
  let visited: Set<string>;
  let scopes: NodePath<Identifier>[];
  let currentIndex = 0;
  let currentCodeSnapshot = code;
  let astDirty = false;

  if (maxBatchSize <= 0) {
    throw new Error(`Invalid batch size: ${maxBatchSize}. batchSize must be greater than 0.`);
  }
  if (batchConcurrency <= 0) {
    throw new Error(`Invalid batch concurrency: ${batchConcurrency}. batchConcurrency must be greater than 0.`);
  }
  if (dirtyCheckpointInterval <= 0) {
    throw new Error(
      `Invalid checkpoint interval: ${dirtyCheckpointInterval}. checkpoint interval must be greater than 0.`
    );
  }
  if (smallScopeMergeLimit < 0) {
    throw new Error(
      `Invalid small scope merge limit: ${smallScopeMergeLimit}. smallScopeMergeLimit must be >= 0.`
    );
  }

  const resumeCodePath = resume?.trim();
  const sessionId = resumeCodePath ? resolveResumeSessionPath(resumeCodePath, filePath) : undefined;
  const legacySessionId = resumeCodePath ? resolveResumeStatePath(resumeCodePath) : undefined;

  // Resume from safe sidecar state; keep one-time legacy fallback for old state path layout.
  if (sessionId) {
    let resumeState = await loadResumeState(sessionId);
    if (!resumeState && legacySessionId && legacySessionId !== sessionId) {
      resumeState = await loadResumeState(legacySessionId);
      if (resumeState) {
        verbose.log(`Loaded legacy resume state from ${legacySessionId}`);
      }
    }
    if (!resumeState && resumeCodePath) {
      resumeState = await loadResumeState(resumeCodePath);
      if (resumeState) {
        verbose.log(`Loaded legacy resume state from ${resumeCodePath}`);
      }
    }
    if (resumeState) {
      ast = await parseAsync(resumeState.code, { sourceType: "unambiguous" });
      if (!ast) {
        throw new Error("Failed to parse code");
      }
      currentCodeSnapshot = resumeState.code;
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
  const groupsToProcess = mergeSmallScopeGroups(
    sortedGroups,
    maxBatchSize,
    smallScopeMergeLimit
  );
  verbose.log(`Merged small scope groups: ${sortedGroups.length} -> ${groupsToProcess.length}`);
  verbose.log(`Sorting groups...`);

  // 预计算总组数用于进度跟踪
  let totalIdentifiers = 0;
  for (const group of groupsToProcess) {
    totalIdentifiers += group.identifiers.length;
  }
  verbose.log("Counting total groups...");

  let processedCount = 0;
  let groupIndex = 0;
  const groupGenerator = splitOversizedGroupsGenerator(groupsToProcess, maxBatchSize);
  verbose.log(`Processing groups...`);
  verbose.log(`Batch concurrency: ${batchConcurrency}`);

  async function saveProgressIfNeeded() {
    if (!sessionId) return;
    const checkpointInterval = astDirty ? dirtyCheckpointInterval : 200;
    if (groupIndex % checkpointInterval !== 0 && processedCount !== totalIdentifiers) return;

    if (astDirty) {
      const newCodeResult = await transformFromAstAsync(ast);
      if (!newCodeResult || !newCodeResult.code) {
        throw new Error("Failed to stringify code");
      }
      currentCodeSnapshot = newCodeResult.code;
      astDirty = false;
    }

    const resumeState: ResumeState = {
      code: currentCodeSnapshot,
      renames: Array.from(renames),
      visited: Array.from(visited),
      currentIndex: processedCount,
      totalScopes: totalIdentifiers,
      codePath: filePath || resumeCodePath || ""
    };
    await saveResumeState(resumeState, sessionId);
  }

  type SplitGroup = { identifiers: NodePath<Identifier>[]; scopeKey: string };
  type PreparedGroup = {
    group: SplitGroup;
    uniqueIdentifiers: NodePath<Identifier>[];
    identifierNames: string[];
    surroundingCode: string;
  };

  async function nextPreparedGroup(): Promise<PreparedGroup | null> {
    while (true) {
      const next = groupGenerator.next();
      if (next.done) {
        return null;
      }
      const group = next.value;

      if (processedCount < currentIndex) {
        processedCount += group.identifiers.length;
        groupIndex++;
        onProgress?.(processedCount / totalIdentifiers);
        continue;
      }

      // 只处理当前绑定作用域尚未处理过的名字（scope+name），避免同一绑定重复发送
      const unvisitedIdentifiers = group.identifiers.filter((identifier) => !hasVisited(identifier, visited));
      if (unvisitedIdentifiers.length === 0) {
        processedCount += group.identifiers.length;
        groupIndex++;
        onProgress?.(processedCount / totalIdentifiers);
        await saveProgressIfNeeded();
        continue;
      }

      // Skip identifiers that have no useful semantic signal (e.g. empty catch params).
      const filteredIdentifiers: NodePath<Identifier>[] = [];
      for (const identifier of unvisitedIdentifiers) {
        if (shouldSkipIdentifierForLLM(identifier)) {
          markVisited(identifier, identifier.node.name, visited);
          verbose.log(`Skipped low-signal identifier: ${identifier.node.name}`);
          continue;
        }
        filteredIdentifiers.push(identifier);
      }
      if (filteredIdentifiers.length === 0) {
        processedCount += group.identifiers.length;
        groupIndex++;
        onProgress?.(processedCount / totalIdentifiers);
        await saveProgressIfNeeded();
        continue;
      }

      const uniqueIdentifierByName = new Map<string, NodePath<Identifier>>();
      for (const identifier of filteredIdentifiers) {
        const name = identifier.node.name;
        if (!uniqueIdentifierByName.has(name)) {
          uniqueIdentifierByName.set(name, identifier);
        }
      }
      const uniqueIdentifiers = Array.from(uniqueIdentifierByName.values());
      const identifierNames = uniqueIdentifiers.map((id) => id.node.name);
      const contextSourcePath = uniqueIdentifiers[0] ?? group.identifiers[0];
      const surroundingCode = await scopesToString(
        ast,
        contextSourcePath,
        contextWindowSize,
        uniqueIdentifiers,
        minInformationScore
      );

      return { group, uniqueIdentifiers, identifierNames, surroundingCode };
    }
  }

  function applyRenameMap(uniqueIdentifiers: NodePath<Identifier>[], renameMap: Record<string, string>) {
    for (const identifier of uniqueIdentifiers) {
      const originalName = identifier.node.name;
      if (!renameMap.hasOwnProperty(originalName)) {
        continue;
      }
      const newName = renameMap[originalName];

      if (newName && newName !== originalName) {
        let safeRenamed = toIdentifier(newName);

        if (uniqueNames) {
          while (
            renames.has(safeRenamed) ||
            identifier.scope.hasBinding(safeRenamed) ||
            WEB_API_NAMES_LIST.includes(safeRenamed)
          ) {
            safeRenamed = renameConflictIndentier(safeRenamed);
          }
        } else {
          while (
            identifier.scope.hasBinding(safeRenamed) || WEB_API_NAMES_LIST.includes(safeRenamed)
          ) {
            safeRenamed = renameConflictIndentier(safeRenamed);
          }
        }

        renames.add(safeRenamed);

        identifier.scope.rename(originalName, safeRenamed);
        astDirty = true;
        verbose.log(`Renamed ${originalName} to ${safeRenamed}`);
      }
      markVisited(identifier, originalName, visited);
    }
  }

  // Process groups in scope size order (smallest to largest).
  // Context extraction stays sequential, but LLM requests run concurrently.
  while (true) {
    const pending: PreparedGroup[] = [];
    while (pending.length < batchConcurrency) {
      const prepared = await nextPreparedGroup();
      if (!prepared) {
        break;
      }
      pending.push(prepared);
    }

    if (pending.length === 0) {
      break;
    }

    const renameMaps = await Promise.all(
      pending.map((item) => visitor(item.identifierNames, item.surroundingCode))
    );

    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      const renameMap = renameMaps[i];
      applyRenameMap(item.uniqueIdentifiers, renameMap);

      processedCount += item.group.identifiers.length;
      groupIndex++;

      await saveProgressIfNeeded();
      onProgress?.(processedCount / totalIdentifiers);
    }
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
  const seenBindings = new Set<string>();
  traverse(ast, {
    BindingIdentifier(path) {
      const declarationPath = getDeclarationIdentifierPath(path);
      const declarationKey = getNodePathIdentityKey(declarationPath);
      if (seenBindings.has(declarationKey)) {
        return;
      }
      seenBindings.add(declarationKey);
      scopes.push(declarationPath);
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
  const bindingBlock = getGroupingScopePath(scope).scope.block;
  return bindingBlock.end! - bindingBlock.start!;
}

/**
 * 使用AST检查作用域信息是否足够，如果不足则向上扩展作用域
 * 并在特定变量后面添加注释提示模型
 * @param path 当前作用域的标识符路径
 * @param contextWindowSize 上下文窗口大小限制
 * @param minInformationScore 最小信息量阈值
 * @param identifiers 需要重命名的标识符列表，用于添加注释
 * @returns 扩展后的作用域代码和路径
 */
async function expandScopeIfInsufficientAST(
  path: NodePath<Identifier>,
  minInformationScore: number = 16,
  identifiers: NodePath<Identifier>[] = []
): Promise<{code: string, path: NodePath}> {
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
      return { code: currentCode, path: currentPath };
    }
  }

  // 信息不足，向上扩展作用域
  let parentPath = currentPath.parentPath;

  while (parentPath && !parentPath.isProgram()) {
    const parentCode = `${parentPath}`;
    const parentAst = parentPath;

    if (parentAst) {
      // const analysisScore = calculateScopeInformationScoreAST(parentPath);
      const analysisScore = parentCode.split("\n").length;
      if (analysisScore >= minInformationScore) {
        // 添加注释到指定变量
        // restore identifiers
        for (const identifier of identifiers) {
          identifier.node.trailingComments = [];
        }
        return { code: parentCode, path: parentPath };
      }
    }

    parentPath = parentPath.parentPath;
  }

  // 如果到达全局作用域或信息仍然不足，返回原始作用域并添加注释
  // restore identifiers
  for (const identifier of identifiers) {
    identifier.node.trailingComments = [];
  }
  return { code: currentCode, path: currentPath };
}

/**
 * 仅返回扩展后的代码（向后兼容的便利函数）
 */
async function expandScopeIfInsufficientASTCode(
  path: NodePath<Identifier>,
  minInformationScore: number = 16,
  identifiers: NodePath<Identifier>[] = []
): Promise<string> {
  const result = await expandScopeIfInsufficientAST(path, minInformationScore, identifiers);
  return result.code;
}

/**
 * 找到包含所有标识符的最小公共上下文
 */
function findMinimalCommonContext(identifiers: NodePath<Identifier>[]): NodePath | null {
  if (identifiers.length === 0) return null;
  if (identifiers.length === 1) return closestSurroundingContextPath(identifiers[0]);
  
  // 从第一个标识符开始，找到它的上下文路径
  let commonContext = closestSurroundingContextPath(identifiers[0]);
  
  // 对于每个其他的标识符，找到它们的公共祖先
  for (let i = 1; i < identifiers.length; i++) {
    const currentContext = closestSurroundingContextPath(identifiers[i]);
    commonContext = findCommonAncestor(commonContext, currentContext);
    
    // 如果已经到达程序级别，就直接返回
    if (commonContext.isProgram()) {
      break;
    }
  }
  
  return commonContext;
}

/**
 * 找到两个路径的最小公共祖先
 */
function findCommonAncestor(path1: NodePath, path2: NodePath): NodePath {
  // 构建path1的祖先链
  const ancestors1 = new Set<NodePath>();
  let current1: NodePath | null = path1;
  while (current1) {
    ancestors1.add(current1);
    current1 = current1.parentPath;
  }
  
  // 沿着path2的祖先链向上查找，找到第一个共同的祖先
  let current2: NodePath | null = path2;
  while (current2) {
    if (ancestors1.has(current2)) {
      return current2;
    }
    current2 = current2.parentPath;
  }
  
  // 理论上不应该到达这里，因为至少程序节点是共同祖先
  throw new Error("No common ancestor found");
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
  return visited.has(getVisitedKey(path, path.node.name));
}

function markVisited(
  path: NodePath<Identifier>,
  originalName: string,
  visited: Set<string>
) {
  visited.add(getVisitedKey(path, originalName));
}

function getVisitedKey(path: NodePath<Identifier>, name: string): string {
  const binding = path.scope.getBinding(name) ?? path.scope.getBinding(path.node.name);
  const bindingScopePath = binding?.scope?.path ?? path.scope.path;
  const bindingScopeNode = bindingScopePath.node;
  const scopeIdentity = bindingScopeNode.loc
    ? `${bindingScopeNode.type}_${bindingScopeNode.loc.start.line}_${bindingScopeNode.loc.start.column}_${bindingScopeNode.loc.end.line}_${bindingScopeNode.loc.end.column}`
    : `${bindingScopeNode.type}_${bindingScopeNode.start || 0}_${bindingScopeNode.end || 0}`;
  const declarationStart = binding?.path?.node.start ?? path.node.start ?? 0;
  return `${scopeIdentity}::${name}::${declarationStart}`;
}

async function scopeToString(
  ast: Node,
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

  const code = `${surroundingPath}`;
  if (code.length < contextWindowSize) {
    return code;
  }

  // 构建上下文代码，通过遍历兄弟节点
  return buildContextFromSiblings(path, contextWindowSize, ast);
}

function buildContextFromSiblings(
  path: NodePath<Identifier>,
  contextWindowSize: number,
  ast?: Node
): string {
  // 找到当前节点所在的容器节点（如函数体、程序等）
  let containerPath = path.getFunctionParent() || path.scope.path;
  
  // 如果容器是函数，直接返回整个函数的表示
  if (containerPath.isFunction()) {
    return `${containerPath}`.slice(0, contextWindowSize);
  }
  
  // 如果容器是Program，使用其body
  if (containerPath.isProgram()) {
    const statements = containerPath.node.body;
    return buildContextFromStatements(statements, path, contextWindowSize, ast);
  }
  
  // 如果容器有body（如函数、块语句等）
  if ('body' in containerPath.node && containerPath.node.body) {
    let statements;
    if (Array.isArray(containerPath.node.body)) {
      statements = containerPath.node.body;
    } else if ('body' in containerPath.node.body && containerPath.node.body.body && Array.isArray(containerPath.node.body.body)) {
      statements = containerPath.node.body.body;
    } else {
      // 单个语句，返回整个容器的代码
      return `${containerPath}`.slice(0, contextWindowSize);
    }
    
    return buildContextFromStatements(statements, path, contextWindowSize, ast);
  }
  
  // 回退到原来的逻辑
  return `${containerPath}`.slice(0, contextWindowSize);
}

// 查找全局变量或函数的所有引用位置
function findGlobalReferences(
  ast: Node,
  targetName: string,
  targetPath: NodePath<Identifier>
): any[] {
  const references: any[] = [];
  
  // 遍历整个AST查找引用
  traverse(ast, {
    Identifier(path) {
      // 跳过目标节点本身
      if (path.node === targetPath.node) {
        return;
      }
      
      // 如果标识符名称匹配
      if (path.node.name === targetName) {
        // 检查是否是引用（不是声明）
        if (path.isReferencedIdentifier()) {
          // 获取包含该引用的语句
          let statementPath = path.getStatementParent();
          if (statementPath && statementPath.node) {
            references.push(statementPath.node);
          }
        }
      }
    }
  });
  
  return references;
}

// 检查标识符是否是全局变量或函数
function isGlobalIdentifier(path: NodePath<Identifier>): boolean {
  const binding = path.scope.getBinding(path.node.name);
  if (!binding) {
    // 没有找到绑定，可能是全局变量
    return true;
  }
  
  // 如果绑定在程序级别的作用域中，也认为是全局的
  const programScope = path.scope.getProgramParent();
  return binding.scope === programScope;
}

function buildContextFromStatements(
  statements: any[],
  targetPath: NodePath<Identifier>,
  contextWindowSize: number,
  ast?: Node
): string {
  // 收集额外的引用语句（如果是全局变量/函数）
  let additionalStatements: any[] = [];
  
  if (ast && isGlobalIdentifier(targetPath)) {
    const globalReferences = findGlobalReferences(ast, targetPath.node.name, targetPath);
    // 过滤掉已经在当前statements中的引用，避免重复
    additionalStatements = globalReferences.filter(refStmt => 
      !statements.some(stmt => stmt.start === refStmt.start && stmt.end === refStmt.end)
    );
  }
  
  // 找到目标节点所在的语句索引
  let targetIndex = -1;
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    if (stmt.start <= targetPath.node.start! && stmt.end >= targetPath.node.end!) {
      targetIndex = i;
      break;
    }
  }
  
  if (targetIndex === -1) {
    // 未找到目标语句，返回所有语句的字符串表示
    const allCode = statements.map(stmt => generate(stmt).code).join('\n');
    return allCode.slice(0, contextWindowSize);
  }
  
  // 从目标语句开始，向两侧扩展
  let contextCode = generate(statements[targetIndex]).code;
  let beforeIndex = targetIndex - 1;
  let afterIndex = targetIndex + 1;
  
  // 交替添加前面和后面的语句，直到达到窗口大小限制
  while ((beforeIndex >= 0 || afterIndex < statements.length) && contextCode.length < contextWindowSize) {
    let added = false;
    
    // 添加前面的语句
    if (beforeIndex >= 0) {
      const beforeStmt = generate(statements[beforeIndex]).code;
      const newCode = beforeStmt + '\n' + contextCode;
      if (newCode.length <= contextWindowSize) {
        contextCode = newCode;
        beforeIndex--;
        added = true;
      }
    }
    
    // 添加后面的语句
    if (afterIndex < statements.length && contextCode.length < contextWindowSize) {
      const afterStmt = generate(statements[afterIndex]).code;
      const newCode = contextCode + '\n' + afterStmt;
      if (newCode.length <= contextWindowSize) {
        contextCode = newCode;
        afterIndex++;
        added = true;
      }
    }
    
    // 如果无法添加更多内容，跳出循环
    if (!added) break;
  }
  
  // 添加全局引用语句到context中（如果还有空间）
  if (additionalStatements.length > 0 && contextCode.length < contextWindowSize) {
    const remainingSize = contextWindowSize - contextCode.length;
    let referencesCode = "\n\n// === Global References ===\n";
    
    for (const refStmt of additionalStatements) {
      const refCode = generate(refStmt).code;
      if (referencesCode.length + refCode.length + 1 <= remainingSize) {
        referencesCode += refCode + '\n';
      } else {
        break;
      }
    }
    
    if (referencesCode.length > remainingSize) {
      referencesCode = referencesCode.slice(0, remainingSize);
    }
    
    contextCode += referencesCode;
  }
  
  return contextCode;
}

async function scopesToString(
  ast: Node,
  path: NodePath<Identifier>,
  contextWindowSize: number,
  identifiers: NodePath<Identifier>[],
  minlines: number = 16
): Promise<string> {
  // 使用AST检查信息量并扩展作用域，添加注释到指定变量
  const result = await expandScopeIfInsufficientAST(path, minlines, identifiers);
  let code = result.code;
  const expandedPath = result.path;
  
  // Program级别上下文很容易过大或过空，仅在多变量批次时收缩到最小公共上下文
  if (expandedPath.isProgram() && identifiers.length > 1) {
    const minimalContext = findMinimalCommonContext(identifiers);
    if (minimalContext && !minimalContext.isProgram()) {
      code = `${minimalContext}`;
    } else {
      // 不再置空，至少保留围绕目标声明的邻居语句
      code = buildContextFromSiblings(path, contextWindowSize, ast);
    }
  }

  let snippets = "";
  const perIdentifierWindow = Math.max(
    120,
    Math.floor(contextWindowSize / Math.max(1, identifiers.length))
  );
  for (const identifier of identifiers) {
    identifier.addComment("trailing", `Rename this ${identifier.node.name}`, false);
    snippets += `\n//========================Code Snippet for ${identifier.node.name}========================\n`;
    snippets += await scopeToString(ast, identifier, perIdentifierWindow);
    snippets += `\n...\n`;
    identifier.node.trailingComments = [];
  }

  let finalCode = "";
  if (code.length > contextWindowSize) {
    if (snippets.length > contextWindowSize) {
      finalCode = snippets.slice(0, contextWindowSize);
    } else {
      finalCode = code.slice(0, contextWindowSize - snippets.length) + snippets;
    }
  } else {
    if (snippets.length > contextWindowSize) {
      finalCode = snippets.slice(0, contextWindowSize);
    } else {
      finalCode = code.slice(0, contextWindowSize - snippets.length) + `\n...\n` + snippets;
    }
  }

  if (identifiers.length === 1) {
    return ensureContextHasMinimumLines(
      finalCode,
      ast,
      identifiers[0],
      contextWindowSize,
      minlines
    );
  }
  return finalCode;
}

function countLines(code: string): number {
  if (code.trim().length === 0) {
    return 0;
  }
  return code.split("\n").length;
}

function ensureContextHasMinimumLines(
  currentContext: string,
  ast: Node,
  targetIdentifier: NodePath<Identifier>,
  contextWindowSize: number,
  minlines: number
): string {
  if (countLines(currentContext) >= minlines) {
    return currentContext;
  }

  const expanded = expandContextByParentLines(
    targetIdentifier,
    ast,
    contextWindowSize,
    minlines
  );
  if (countLines(expanded) <= countLines(currentContext)) {
    return currentContext;
  }

  const focusHint = `\n// Focus identifier: ${targetIdentifier.node.name}\n`;
  if (expanded.length + focusHint.length <= contextWindowSize) {
    return expanded + focusHint;
  }
  return expanded.slice(0, contextWindowSize);
}

function expandContextByParentLines(
  targetIdentifier: NodePath<Identifier>,
  ast: Node,
  contextWindowSize: number,
  minlines: number
): string {
  let currentPath: NodePath | null = closestSurroundingContextPath(targetIdentifier);
  let bestContext = currentPath ? `${currentPath}`.slice(0, contextWindowSize) : "";
  let bestLines = countLines(bestContext);

  while (currentPath) {
    const candidate = `${currentPath}`;
    const candidateLines = countLines(candidate);
    if (candidateLines > bestLines) {
      bestContext = candidate.slice(0, contextWindowSize);
      bestLines = candidateLines;
    }
    if (candidateLines >= minlines) {
      return candidate.slice(0, contextWindowSize);
    }
    if (currentPath.isProgram()) {
      break;
    }
    currentPath = currentPath.parentPath;
  }

  const siblingContext = buildContextFromSiblings(
    targetIdentifier,
    contextWindowSize,
    ast
  );
  if (countLines(siblingContext) > bestLines) {
    return siblingContext.slice(0, contextWindowSize);
  }
  return bestContext.slice(0, contextWindowSize);
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

function mergeSmallScopeGroups(
  groups: Array<{ identifiers: NodePath<Identifier>[], scopeKey: string }>,
  maxBatchSize: number,
  smallScopeMergeLimit: number
): Array<{ identifiers: NodePath<Identifier>[], scopeKey: string }> {
  if (smallScopeMergeLimit <= 0) {
    return groups;
  }

  const merged: Array<{ identifiers: NodePath<Identifier>[], scopeKey: string }> = [];
  let pendingIdentifiers: NodePath<Identifier>[] = [];
  let pendingScopeKeys: string[] = [];
  let pendingNames = new Set<string>();
  let pendingBoundaryKey = "";
  let pendingLastStart = 0;

  const flushPending = () => {
    if (pendingIdentifiers.length === 0) {
      return;
    }
    merged.push({
      identifiers: pendingIdentifiers,
      scopeKey: pendingScopeKeys.join("__merged__")
    });
    pendingIdentifiers = [];
    pendingScopeKeys = [];
    pendingNames = new Set<string>();
    pendingBoundaryKey = "";
    pendingLastStart = 0;
  };

  for (const group of groups) {
    const isMergeable = group.identifiers.length <= smallScopeMergeLimit;
    if (!isMergeable) {
      flushPending();
      merged.push(group);
      continue;
    }
    if (group.identifiers.some((identifier) => shouldSkipIdentifierForLLM(identifier))) {
      flushPending();
      merged.push(group);
      continue;
    }

    const groupBoundaryKey = getMergeBoundaryKey(group.identifiers[0]);
    const groupStart = group.identifiers[0].node.start ?? 0;
    const groupNames = new Set(group.identifiers.map((identifier) => identifier.node.name));
    const hasNameConflict = Array.from(groupNames).some((name) => pendingNames.has(name));
    const wouldExceedBatchSize =
      pendingIdentifiers.length > 0 &&
      pendingIdentifiers.length + group.identifiers.length > maxBatchSize;
    const boundaryMismatch =
      pendingIdentifiers.length > 0 &&
      groupBoundaryKey !== pendingBoundaryKey;
    const tooFarFromPrevious =
      pendingIdentifiers.length > 0 &&
      Math.abs(groupStart - pendingLastStart) > 5000;
    if (hasNameConflict || wouldExceedBatchSize || boundaryMismatch || tooFarFromPrevious) {
      flushPending();
    }

    pendingIdentifiers = pendingIdentifiers.concat(group.identifiers);
    pendingScopeKeys.push(group.scopeKey);
    for (const name of groupNames) {
      pendingNames.add(name);
    }
    pendingBoundaryKey = groupBoundaryKey;
    pendingLastStart = groupStart;
  }
  flushPending();
  return merged;
}

function shouldSkipIdentifierForLLM(path: NodePath<Identifier>): boolean {
  if (path.parentPath?.isCatchClause() && path.key === "param") {
    const catchClause = path.parentPath.node;
    if (catchClause.body?.body?.length === 0) {
      return true;
    }
  }
  return false;
}

function getMergeBoundaryKey(path: NodePath<Identifier>): string {
  const boundaryPath = path.findParent(
    (p) => p.isProgram() || p.isFunction() || p.isClassDeclaration() || p.isClassExpression()
  ) as NodePath<Node> | null;
  return getNodePathIdentityKey((boundaryPath ?? path.scope.path) as NodePath<Node>);
}

// 第二步：将过大的组切分为多个批次（流式处理，减少内存占用）
function* splitOversizedGroupsGenerator(
  groups: Array<{ identifiers: NodePath<Identifier>[], scopeKey: string }>,
  maxBatchSize: number = 10
): IterableIterator<{ identifiers: NodePath<Identifier>[], scopeKey: string }> {
  for (const group of groups) {
    const { identifiers, scopeKey } = group;

    let identifiersList: NodePath<Identifier>[] = [];
    for (var i = 0; i < identifiers.length; i++) {
      const identifier = identifiers[i];
      if (identifiersList.length >= maxBatchSize) {
        if (identifiersList.length === 0) {
          continue;
        }
        yield {
          identifiers: identifiersList,
          scopeKey: `${scopeKey}_${i}`
        };
        identifiersList = [];
      }
      identifiersList.push(identifier);
    }

    if (identifiersList.length === 0) {
      continue;
    }
    yield {
      identifiers: identifiersList,
      scopeKey: `${scopeKey}_${i}`
    };
    identifiersList = [];
  }
}

// 同步版本的splitOversizedGroups用于旧的groupIdentifiersByScope
async function splitOversizedGroups(
  ast: Node,
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
      const surroundingCode = await scopesToString(ast, firstScope, contextWindowSize, identifiers, minlines);
      result.push({
        identifiers,
        scopeKey,
        surroundingCode
      });
    } else {
      for (let i = 0; i < identifiers.length; i += maxBatchSize) {
        const batchIdentifiers = identifiers.slice(i, i + maxBatchSize);
        const firstScope = batchIdentifiers[0];
        const surroundingCode = await scopesToString(ast, firstScope, contextWindowSize, batchIdentifiers, minlines);
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
  ast: Node,
  scopes: NodePath<Identifier>[],
  contextWindowSize: number,
  maxBatchSize: number = 10,
  minInformationScore: number = 16
): Promise<Array<{ identifiers: NodePath<Identifier>[], scopeKey: string, surroundingCode: string }>> {
  // 第一步：按作用域位置分组
  const grouped = groupByScopePosition(scopes);

  // 第二步：切分过大的组
  return await splitOversizedGroups(ast, grouped, contextWindowSize, maxBatchSize, minInformationScore);
}


// 获取作用域的位置key，避免存储完整代码
function getScopePositionKey(scope: NodePath<Identifier>): string {
  const contextPath = getGroupingScopePath(scope);
  const node = contextPath.node;

  if (node.loc) {
    return `${node.type}_${node.loc.start.line}_${node.loc.start.column}_${node.loc.end.line}_${node.loc.end.column}`;
  }

  // 如果没有位置信息，使用节点类型和哈希
  return `${node.type}_${node.start || 0}`;
}

function getGroupingScopePath(path: NodePath<Identifier>): NodePath<Node> {
  const declarationPath = getDeclarationIdentifierPath(path);
  if (
    declarationPath.key === "id" &&
    (declarationPath.parentPath?.isFunctionDeclaration() ||
      declarationPath.parentPath?.isClassDeclaration())
  ) {
    return declarationPath.parentPath as NodePath<Node>;
  }

  const binding = declarationPath.scope.getBinding(declarationPath.node.name);
  return (binding?.scope?.path as NodePath<Node>) ?? (declarationPath.scope.path as NodePath<Node>);
}

function getDeclarationIdentifierPath(path: NodePath<Identifier>): NodePath<Identifier> {
  const binding = path.scope.getBinding(path.node.name);
  if (binding?.path?.isIdentifier()) {
    return binding.path as NodePath<Identifier>;
  }
  return path;
}

function getNodePathIdentityKey(path: NodePath<Node>): string {
  if (path.node.loc) {
    return `${path.node.type}_${path.node.loc.start.line}_${path.node.loc.start.column}_${path.node.loc.end.line}_${path.node.loc.end.column}`;
  }
  return `${path.node.type}_${path.node.start || 0}_${path.node.end || 0}`;
}

function closestSurroundingContextPath(
  path: NodePath<Identifier>
): NodePath<Node> {
  const programOrBindingNode = path.findParent(
    (p) => p.isProgram() || path.node.name in p.getOuterBindingIdentifiers()
  )?.scope.path;
  return programOrBindingNode ?? path.scope.path;
}
