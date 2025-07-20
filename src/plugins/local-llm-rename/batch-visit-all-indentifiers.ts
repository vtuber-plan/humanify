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

  // 按surroundingCode分组identifier
  const groupedScopes = await groupIdentifiersByScope(scopes, contextWindowSize, maxBatchSize, overlapThreshold);
  const numGroups = groupedScopes.length;

  // Process groups
  for (let i = currentIndex; i < groupedScopes.length; i++) {
    const group = groupedScopes[i];
    
    // 检查是否已经处理过这个组中的所有identifier
    const unvisitedIdentifiers = group.identifiers.filter(id => !hasVisited(id, visited));
    if (unvisitedIdentifiers.length === 0) continue;

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

    // Save progress periodically
    if (sessionId && (i % 5 === 0 || i === groupedScopes.length - 1)) {
      const newCodeResult = await transformFromAstAsync(ast);
      if (!newCodeResult || !newCodeResult.code) {
        throw new Error("Failed to stringify code");
      }
      
      const resumeState: ResumeState = {
        code: newCodeResult?.code,
        renames: Array.from(renames),
        visited: Array.from(visited),
        currentIndex: i + 1,
        totalScopes: groupedScopes.length,
        codePath: resume || ""
      };
      await saveResumeState(resumeState, sessionId);
    }

    onProgress?.(visited.size / numGroups);
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

function findScopes(ast: Node): NodePath<Identifier>[] {
  const scopes: [nodePath: NodePath<Identifier>, scopeSize: number][] = [];
  traverse(ast, {
    BindingIdentifier(path) {
      const bindingBlock = closestSurroundingContextPath(path).scope.block;
      const pathSize = bindingBlock.end! - bindingBlock.start!;

      scopes.push([path, pathSize]);
    }
  });

  scopes.sort((a, b) => b[1] - a[1]);

  return scopes.map(([nodePath]) => nodePath);
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
  const surroundingPath = closestSurroundingContextPath(path);
  const code = `${surroundingPath}`; // Implements a hidden `.toString()`
  if (code.length < contextWindowSize) {
    return code;
  }
  if (surroundingPath.isProgram()) {
    const start = path.node.start ?? 0;
    const end = path.node.end ?? code.length;
    if (end < contextWindowSize / 2) {
      return code.slice(0, contextWindowSize);
    }
    if (start > code.length - contextWindowSize / 2) {
      return code.slice(-contextWindowSize);
    }

    return code.slice(
      start - contextWindowSize / 2,
      end + contextWindowSize / 2
    );
  } else {
    return code.slice(0, contextWindowSize);
  }
}

// 按surroundingCode分组identifier的辅助函数
async function groupIdentifiersByScope(
  scopes: NodePath<Identifier>[],
  contextWindowSize: number,
  maxBatchSize: number = 10, // 最大批次大小
  overlapThreshold: number = 0.7 // 重叠阈值（70%）
): Promise<Array<{ identifiers: NodePath<Identifier>[], surroundingCode: string }>> {
  const groups: Array<{ identifiers: NodePath<Identifier>[], surroundingCode: string }> = [];
  
  for (const scope of scopes) {
    const surroundingCode = await scopeToString(scope, contextWindowSize);

    // 寻找合适的现有组
    let foundGroup = false;
    for (const group of groups) {
      // 检查是否达到批次大小限制
      if (group.identifiers.length >= maxBatchSize) {
        continue;
      }
      
      // 检查是否在相同的作用域中
      if (areInSameScope(scope, group.identifiers[0])) {
        // 如果在相同作用域，则计算代码重叠度
        const overlapRatio = calculateCodeOverlap(surroundingCode, group.surroundingCode);
        
        if (overlapRatio >= overlapThreshold) {
          group.identifiers.push(scope);
          foundGroup = true;
          break;
        }
      }
    }
    
    // 如果没有找到合适的组，创建新组
    if (!foundGroup) {
      groups.push({
        identifiers: [scope],
        surroundingCode: surroundingCode
      });
    }
  }
  
  return groups;
}

// 检查两个标识符是否在相同的作用域中
function areInSameScope(path1: NodePath<Identifier>, path2: NodePath<Identifier>): boolean {
  // 获取两个标识符的最近的包含作用域
  const scope1 = closestSurroundingContextPath(path1);
  const scope2 = closestSurroundingContextPath(path2);
  
  // 如果是同一个节点，则在同一作用域
  if (scope1.node === scope2.node) {
    return true;
  }
  
  // 检查是否在同一个函数内
  const func1 = path1.getFunctionParent();
  const func2 = path2.getFunctionParent();
  
  // 如果都没有函数父级，则都在全局作用域
  if (!func1 && !func2) {
    return true;
  }
  
  // 如果都在同一个函数内
  if (func1 && func2 && func1.node === func2.node) {
    return true;
  }
  
  return false;
}

// 计算两段代码的重叠度
function calculateCodeOverlap(code1: string, code2: string): number {
  // 将代码按行分割，去除空行和只包含空白字符的行
  const lines1 = code1.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.match(/^[{}();\s]*$/));
  const lines2 = code2.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.match(/^[{}();\s]*$/));
  
  if (lines1.length === 0 || lines2.length === 0) {
    return 0;
  }
  
  // 检查是否包含不同的函数定义，如果是则重叠度为0
  const functionRegex = /function\s+(\w+)|const\s+(\w+)\s*=.*function|(\w+)\s*\(/;
  const functions1 = lines1.filter(line => functionRegex.test(line));
  const functions2 = lines2.filter(line => functionRegex.test(line));
  
  if (functions1.length > 0 && functions2.length > 0) {
    const func1Names = functions1.map(f => f.match(functionRegex)?.[1] || f.match(functionRegex)?.[2] || f.match(functionRegex)?.[3]).filter(Boolean);
    const func2Names = functions2.map(f => f.match(functionRegex)?.[1] || f.match(functionRegex)?.[2] || f.match(functionRegex)?.[3]).filter(Boolean);
    
    // 如果函数名不同，则认为不重叠
    const hasCommonFunction = func1Names.some(name => func2Names.includes(name));
    if (!hasCommonFunction) {
      return 0;
    }
  }
  
  // 计算重叠的行数
  let overlapCount = 0;
  const lines2Set = new Set(lines2);
  
  for (const line of lines1) {
    if (lines2Set.has(line)) {
      overlapCount++;
    }
  }
  
  // 返回重叠比例（相对于较短的代码段）
  const minLength = Math.min(lines1.length, lines2.length);
  return overlapCount / minLength;
}

function closestSurroundingContextPath(
  path: NodePath<Identifier>
): NodePath<Node> {
  const programOrBindingNode = path.findParent(
    (p) => p.isProgram() || path.node.name in p.getOuterBindingIdentifiers()
  )?.scope.path;
  return programOrBindingNode ?? path.scope.path;
}
