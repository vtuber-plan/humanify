import { parseAsync, transformFromAstAsync, NodePath } from "@babel/core";
import * as babelTraverse from "@babel/traverse";
import { Identifier, toIdentifier, Node } from "@babel/types";
import {
  ResumeState,
  saveResumeState,
  loadResumeState,
  deleteResumeState,
  resolveResumeStatePath,
  resolveResumeSessionPath
} from "../../resume-utils.js";
import { verbose } from "../../verbose.js";

const traverse: typeof babelTraverse.default.default = (
  typeof babelTraverse.default === "function"
    ? babelTraverse.default
    : babelTraverse.default.default
) as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- This hack is because pkgroll fucks up the import somehow

type Visitor = (name: string, scope: string) => Promise<string>;

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

function renameConflictIdentifierWithDeterministicSuffix(name: string): string {
  if (endWithNumber(name)) {
    const suffixNumber = getSuffixNumber(name);
    return name.replace(/(\d+)$/, (match) => (parseInt(match, 10) + 1).toString());
  }
  return `${name}1`;
}

export async function visitAllIdentifiers(
  code: string,
  visitor: Visitor,
  contextWindowSize: number,
  onProgress?: (percentageDone: number) => void,
  resume?: string,
  filePath?: string,
  uniqueNames = false
): Promise<string> {
  let ast: Node | null;
  let renames: Set<string>;
  let visited: Set<string>;
  let scopes: NodePath<Identifier>[];
  let currentIndex = 0;

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
    const originalName = smallestScopeNode.name;

    const surroundingCode = await scopeToString(
      smallestScope,
      contextWindowSize
    );
    const renamed = await visitor(originalName, surroundingCode);
    if (renamed !== originalName) {
      let safeRenamed = toIdentifier(renamed);
      while (
        renames.has(safeRenamed) ||
        smallestScope.scope.hasBinding(safeRenamed)
      ) {
        safeRenamed = uniqueNames
          ? renameConflictIndentier(safeRenamed)
          : renameConflictIdentifierWithDeterministicSuffix(safeRenamed);
      }
      renames.add(safeRenamed);

      smallestScope.scope.rename(originalName, safeRenamed);
    }
    markVisited(smallestScope, visited);

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
        codePath: filePath || resumeCodePath || "",
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
  return visited.has(getVisitedKey(path));
}

function markVisited(
  path: NodePath<Identifier>,
  visited: Set<string>
) {
  visited.add(getVisitedKey(path));
}

function getVisitedKey(path: NodePath<Identifier>): string {
  const binding = path.scope.getBinding(path.node.name);
  const bindingScopePath = binding?.scope?.path ?? path.scope.path;
  const bindingScopeNode = bindingScopePath.node;
  const scopeIdentity = bindingScopeNode.loc
    ? `${bindingScopeNode.type}_${bindingScopeNode.loc.start.line}_${bindingScopeNode.loc.start.column}_${bindingScopeNode.loc.end.line}_${bindingScopeNode.loc.end.column}`
    : `${bindingScopeNode.type}_${bindingScopeNode.start || 0}_${bindingScopeNode.end || 0}`;
  const declarationNode = binding?.path?.node ?? path.node;
  const declarationIdentity = declarationNode.loc
    ? `${declarationNode.type}_${declarationNode.loc.start.line}_${declarationNode.loc.start.column}_${declarationNode.loc.end.line}_${declarationNode.loc.end.column}`
    : `${declarationNode.type}_${declarationNode.start || 0}_${declarationNode.end || 0}`;
  return `${scopeIdentity}::${declarationIdentity}`;
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

function closestSurroundingContextPath(
  path: NodePath<Identifier>
): NodePath<Node> {
  const programOrBindingNode = path.findParent(
    (p) => p.isProgram() || path.node.name in p.getOuterBindingIdentifiers()
  )?.scope.path;
  return programOrBindingNode ?? path.scope.path;
}
