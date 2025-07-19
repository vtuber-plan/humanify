import * as t from '@babel/types';
import { NodePath } from '@babel/core';
import { TokenMapping } from './sourcemap-generator.js';
import { ScopeAwareMappingGenerator } from './scope-aware-mapping.js';

/**
 * AST节点位置跟踪器
 * 用于在Babel变换过程中记录原始代码和生成代码之间的位置映射
 */
export class ASTPositionTracker {
  private scopeAwareMappingGenerator: ScopeAwareMappingGenerator;
  private originalCode: string;
  
  constructor(originalCode: string) {
    this.originalCode = originalCode;
    this.scopeAwareMappingGenerator = new ScopeAwareMappingGenerator();
  }

  /**
   * 记录标识符重命名的映射
   * @param path Babel节点路径
   * @param originalName 原始名称
   * @param newName 新名称
   */
  recordIdentifierRename(path: NodePath<t.Identifier>, originalName: string, newName: string): void {
    const node = path.node;
    if (node.loc && node.loc.start) {
      // 生成作用域ID - 简单实现，实际应该更复杂
      const scopeId = this.generateScopeId(path);
      
      this.scopeAwareMappingGenerator.recordRename(
        originalName,
        newName,
        scopeId,
        node.loc.start.line,
        node.loc.start.column
      );
    }
  }

  /**
   * 生成作用域ID
   */
  private generateScopeId(path: NodePath<t.Identifier>): string {
    const scopePath = path.scope.path;
    if (scopePath.isFunction()) {
      return `function_${scopePath.node.start || 0}`;
    } else if (scopePath.isProgram()) {
      return 'global';
    } else if (scopePath.isBlockStatement()) {
      return `block_${scopePath.node.start || 0}`;
    }
    return `scope_${scopePath.node.start || 0}`;
  }

  /**
   * 记录一般的AST节点映射
   * @param originalNode 原始节点
   * @param generatedNode 生成的节点
   */
  recordNodeMapping(originalNode: t.Node, generatedNode: t.Node): void {
    // 这个方法现在不需要实现，因为我们使用作用域感知映射生成器
  }

  /**
   * 根据生成的代码生成精确映射
   * @param generatedCode 生成的代码
   */
  generateMappings(generatedCode: string): TokenMapping[] {
    return this.scopeAwareMappingGenerator.generateMappings(this.originalCode, generatedCode);
  }

  /**
   * 获取所有映射（向后兼容）
   */
  getMappings(): TokenMapping[] {
    // 这个方法需要在调用前先调用generateMappings
    return [];
  }

  /**
   * 清空映射记录
   */
  clear(): void {
    this.scopeAwareMappingGenerator.clear();
  }
}

/**
 * 创建一个全局的位置跟踪器实例
 */
let globalTracker: ASTPositionTracker | null = null;

export function initializeTracker(originalCode: string): ASTPositionTracker {
  globalTracker = new ASTPositionTracker(originalCode);
  return globalTracker;
}

export function getGlobalTracker(): ASTPositionTracker | null {
  return globalTracker;
}

export function clearGlobalTracker(): void {
  globalTracker = null;
} 