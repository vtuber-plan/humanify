import { parse } from '@babel/parser';
import * as babelTraverse from '@babel/traverse';
import * as t from '@babel/types';
import { TokenMapping } from './sourcemap-generator.js';

const traverse: typeof babelTraverse.default.default = (
  typeof babelTraverse.default === "function"
    ? babelTraverse.default
    : babelTraverse.default.default
) as any;

/**
 * 变量实例信息，包含作用域和位置信息
 */
interface VariableInstance {
  name: string;
  line: number;
  column: number;
  scopeId: string; // 作用域唯一标识
  bindingKind: 'var' | 'let' | 'const' | 'function' | 'parameter' | 'unknown';
  // 添加更多上下文信息帮助匹配
  parentType: string; // 父节点类型
  isDeclaration: boolean; // 是否是声明
  functionName?: string; // 所在函数名
  scopeDepth: number; // 作用域深度
}

/**
 * 重命名记录
 */
interface RenameRecord {
  originalName: string;
  newName: string;
  scopeId: string;
  line: number;
  column: number;
}

/**
 * 作用域感知的source-map映射生成器
 */
export class ScopeAwareMappingGenerator {
  private renameRecords: RenameRecord[] = [];

  /**
   * 记录变量重命名，包含作用域信息
   */
  recordRename(
    originalName: string, 
    newName: string, 
    scopeId: string, 
    line: number, 
    column: number
  ): void {
    this.renameRecords.push({
      originalName,
      newName,
      scopeId,
      line,
      column
    });
  }

  /**
   * 生成作用域感知的精确映射
   */
  generateMappings(originalCode: string, generatedCode: string): TokenMapping[] {
    const mappings: TokenMapping[] = [];

    try {
      // 分析原始代码的变量实例
      const originalInstances = this.analyzeVariableInstances(originalCode);
      
      // 分析生成代码的变量实例
      const generatedInstances = this.analyzeVariableInstances(generatedCode);

      // 为每个重命名记录建立映射
      for (const renameRecord of this.renameRecords) {
        // 在原始代码中找到匹配的变量实例
        const originalInstance = this.findMatchingOriginalInstance(
          originalInstances, 
          renameRecord
        );

        if (originalInstance) {
          // 在生成代码中找到对应的重命名变量实例
          const generatedInstance = this.findMatchingGeneratedInstance(
            generatedInstances,
            renameRecord,
            originalInstance
          );

          if (generatedInstance) {
            mappings.push({
              original: {
                line: originalInstance.line,
                column: originalInstance.column
              },
              generated: {
                line: generatedInstance.line,
                column: generatedInstance.column
              },
              name: generatedInstance.name
            });
          }
        }
      }

    } catch (error) {
      console.warn('Failed to generate scope-aware mappings, falling back to simple mapping:', error);
      return this.generateSimpleMappings(originalCode, generatedCode);
    }

    return mappings;
  }

  /**
   * 分析代码中的变量实例，包含作用域信息
   */
  private analyzeVariableInstances(code: string): VariableInstance[] {
    const instances: VariableInstance[] = [];
    
    const ast = parse(code, {
      sourceType: 'unambiguous',
      ranges: true
    });

    let scopeCounter = 0;
    const scopeStack: string[] = [];

    // 获取函数名的辅助函数
    const getFunctionName = (path: any): string | undefined => {
      let current = path;
      while (current) {
        if (current.isFunction()) {
          if (current.node.id?.name) {
            return current.node.id.name;
          }
          break;
        }
        current = current.parentPath;
      }
      return undefined;
    };

    traverse(ast, {
      enter(path: any) {
        // 进入新作用域时创建作用域ID
        if (path.isFunction() || path.isProgram() || path.isBlockStatement()) {
          const scopeId = `scope_${scopeCounter++}`;
          scopeStack.push(scopeId);
        }
      },
      
      exit(path: any) {
        // 离开作用域时弹出
        if (path.isFunction() || path.isProgram() || path.isBlockStatement()) {
          scopeStack.pop();
        }
      },

      Identifier(path: any) {
        const node = path.node;
        if (!node.loc) return;

        const currentScopeId = scopeStack[scopeStack.length - 1] || 'global';
        const binding = path.scope.getBinding(node.name);
        
        instances.push({
          name: node.name,
          line: node.loc.start.line,
          column: node.loc.start.column,
          scopeId: currentScopeId,
          bindingKind: binding ? binding.kind : 'unknown',
          parentType: path.parent?.type || 'unknown',
          isDeclaration: path.isBindingIdentifier(),
          functionName: getFunctionName(path),
          scopeDepth: scopeStack.length
        });
      }
    });

    return instances;
  }



  /**
   * 在原始代码中找到匹配的变量实例
   */
  private findMatchingOriginalInstance(
    instances: VariableInstance[],
    renameRecord: RenameRecord
  ): VariableInstance | undefined {
    // 首先尝试精确匹配（名称+位置）
    let match = instances.find(instance => 
      instance.name === renameRecord.originalName &&
      instance.line === renameRecord.line &&
      instance.column === renameRecord.column
    );

    if (match) return match;

    // 如果精确匹配失败，尝试在相同作用域中找到最接近的匹配
    const candidates = instances.filter(instance => 
      instance.name === renameRecord.originalName &&
      instance.scopeId === renameRecord.scopeId
    );

    if (candidates.length === 1) {
      return candidates[0];
    }

    // 如果有多个候选，选择位置最接近的
    if (candidates.length > 1) {
      return candidates.reduce((closest, current) => {
        const closestDistance = Math.abs(closest.line - renameRecord.line) + 
                               Math.abs(closest.column - renameRecord.column);
        const currentDistance = Math.abs(current.line - renameRecord.line) + 
                               Math.abs(current.column - renameRecord.column);
        return currentDistance < closestDistance ? current : closest;
      });
    }

    return undefined;
  }

  /**
   * 在生成代码中找到对应的重命名变量实例
   */
  private findMatchingGeneratedInstance(
    instances: VariableInstance[],
    renameRecord: RenameRecord,
    originalInstance: VariableInstance
  ): VariableInstance | undefined {
    // 找到所有同名的新变量实例
    const candidates = instances.filter(instance => 
      instance.name === renameRecord.newName
    );

    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];

    // 如果有多个候选，使用多个条件进行匹配
    let bestMatch = candidates[0];
    let bestScore = this.calculateMatchScore(bestMatch, originalInstance, renameRecord);

    for (let i = 1; i < candidates.length; i++) {
      const score = this.calculateMatchScore(candidates[i], originalInstance, renameRecord);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = candidates[i];
      }
    }

    return bestMatch;
  }

  /**
   * 计算匹配分数
   */
  private calculateMatchScore(
    candidate: VariableInstance,
    originalInstance: VariableInstance,
    renameRecord: RenameRecord
  ): number {
    let score = 0;

    // 绑定类型匹配
    if (candidate.bindingKind === originalInstance.bindingKind) {
      score += 10;
    }

    // 父节点类型匹配
    if (candidate.parentType === originalInstance.parentType) {
      score += 5;
    }

    // 声明类型匹配
    if (candidate.isDeclaration === originalInstance.isDeclaration) {
      score += 5;
    }

    // 函数名匹配
    if (candidate.functionName === originalInstance.functionName) {
      score += 3;
    }

    // 作用域深度匹配
    if (candidate.scopeDepth === originalInstance.scopeDepth) {
      score += 2;
    }

    // 位置接近度（行号差距）
    const lineDistance = Math.abs(candidate.line - originalInstance.line);
    score += Math.max(0, 10 - lineDistance);

    return score;
  }

  /**
   * 简单映射作为降级方案
   */
  private generateSimpleMappings(originalCode: string, generatedCode: string): TokenMapping[] {
    const mappings: TokenMapping[] = [];
    const originalLines = originalCode.split('\n');
    const generatedLines = generatedCode.split('\n');

    for (let generatedLine = 0; generatedLine < generatedLines.length; generatedLine++) {
      const originalLine = Math.min(generatedLine, originalLines.length - 1);
      
      mappings.push({
        generated: {
          line: generatedLine + 1,
          column: 0
        },
        original: {
          line: originalLine + 1,
          column: 0
        }
      });
    }

    return mappings;
  }

  /**
   * 清空记录
   */
  clear(): void {
    this.renameRecords = [];
  }

  /**
   * 获取重命名记录数量
   */
  getRenameCount(): number {
    return this.renameRecords.length;
  }

  /**
   * 获取所有重命名记录
   */
  getRenameRecords(): Array<{
    originalName: string;
    newName: string;
    scopeId: string;
    line: number;
    column: number;
  }> {
    return [...this.renameRecords];
  }
} 