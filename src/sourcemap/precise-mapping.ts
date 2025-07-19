import { parse } from '@babel/parser';
import * as babelTraverse from '@babel/traverse';
import * as t from '@babel/types';
import { TokenMapping } from './sourcemap-generator.js';

const traverse: typeof babelTraverse.default.default = (
  typeof babelTraverse.default === "function"
    ? babelTraverse.default
    : babelTraverse.default.default
) as any;

export interface IdentifierMapping {
  originalName: string;
  newName: string;
  // 可以添加更多上下文信息
}

/**
 * 精确的source-map映射生成器
 * 通过分析原始代码和生成代码来建立准确的token级别映射
 */
export class PreciseMappingGenerator {
  private identifierMappings: Map<string, string> = new Map();

  /**
   * 记录标识符重命名关系
   */
  recordRename(originalName: string, newName: string): void {
    this.identifierMappings.set(originalName, newName);
  }

  /**
   * 生成精确的token映射
   */
  generateMappings(originalCode: string, generatedCode: string): TokenMapping[] {
    const mappings: TokenMapping[] = [];

    try {
      // 解析原始代码和生成代码的AST
      const originalAst = parse(originalCode, {
        sourceType: 'unambiguous',
        ranges: true
      });

      const generatedAst = parse(generatedCode, {
        sourceType: 'unambiguous',
        ranges: true
      });

      // 收集原始代码中的标识符位置
      const originalIdentifiers: Array<{
        name: string;
        line: number;
        column: number;
      }> = [];

      const self = this;
      traverse(originalAst, {
        Identifier(path: any) {
          const node = path.node;
          if (node.loc && self.identifierMappings.has(node.name)) {
            originalIdentifiers.push({
              name: node.name,
              line: node.loc.start.line,
              column: node.loc.start.column
            });
          }
        }
      });

      // 收集生成代码中的标识符位置
      const generatedIdentifiers: Array<{
        name: string;
        line: number;
        column: number;
      }> = [];

      traverse(generatedAst, {
        Identifier(path) {
          const node = path.node;
          if (node.loc) {
            generatedIdentifiers.push({
              name: node.name,
              line: node.loc.start.line,
              column: node.loc.start.column
            });
          }
        }
      });

      // 建立映射关系
      for (const originalId of originalIdentifiers) {
        const newName = this.identifierMappings.get(originalId.name);
        if (newName) {
          // 在生成代码中找到对应的重命名标识符
          const generatedId = generatedIdentifiers.find(genId => genId.name === newName);
          if (generatedId) {
            mappings.push({
              original: {
                line: originalId.line,
                column: originalId.column
              },
              generated: {
                line: generatedId.line,
                column: generatedId.column
              },
              name: newName
            });
          }
        }
      }

    } catch (error) {
      console.warn('Failed to generate precise mappings, falling back to line mapping:', error);
      // 降级到简单的行映射
      return this.generateLineMappings(originalCode, generatedCode);
    }

    return mappings;
  }

  /**
   * 降级的行映射生成
   */
  private generateLineMappings(originalCode: string, generatedCode: string): TokenMapping[] {
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
   * 清空映射记录
   */
  clear(): void {
    this.identifierMappings.clear();
  }

  /**
   * 获取所有重命名映射
   */
  getRenameMappings(): Map<string, string> {
    return new Map(this.identifierMappings);
  }
} 