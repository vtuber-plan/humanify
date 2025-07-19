import { SourceMapGenerator, Position } from 'source-map';
import fs from 'fs/promises';
import path from 'path';

export interface SourceMapOptions {
  originalFile: string;
  generatedFile: string;
  outputDir: string;
}

export interface TokenMapping {
  original: Position;
  generated: Position;
  name?: string;
}

/**
 * 高级source-map生成器，支持token级别的精确映射
 */
export class AdvancedSourceMapGenerator {
  private generator: SourceMapGenerator;
  private mappings: TokenMapping[] = [];

  constructor(options: SourceMapOptions) {
    this.generator = new SourceMapGenerator({
      file: path.basename(options.generatedFile),
      sourceRoot: '.'
    });
  }

  /**
   * 设置原始源文件内容
   */
  setSourceContent(filename: string, content: string): void {
    this.generator.setSourceContent(filename, content);
  }

  /**
   * 添加token级别的映射
   */
  addMapping(mapping: TokenMapping): void {
    this.mappings.push(mapping);
    this.generator.addMapping({
      generated: mapping.generated,
      original: mapping.original,
      source: 'original.js',
      name: mapping.name
    });
  }

  /**
   * 批量添加映射
   */
  addMappings(mappings: TokenMapping[]): void {
    mappings.forEach(mapping => this.addMapping(mapping));
  }

  /**
   * 生成source map字符串
   */
  toString(): string {
    return this.generator.toString();
  }
}

/**
 * 简化版本：生成基于AST节点位置的source map
 */
export async function generateSourceMap(
  originalCode: string,
  generatedCode: string,
  options: SourceMapOptions,
  mappings?: TokenMapping[]
): Promise<string> {
  const generator = new AdvancedSourceMapGenerator(options);
  
  // 添加原始文件内容
  generator.setSourceContent('original.js', originalCode);

  if (mappings && mappings.length > 0) {
    // 使用提供的精确映射
    generator.addMappings(mappings);
  } else {
    // 降级到行级映射（保持向后兼容）
    const originalLines = originalCode.split('\n');
    const generatedLines = generatedCode.split('\n');

    for (let generatedLine = 0; generatedLine < generatedLines.length; generatedLine++) {
      const originalLine = Math.min(generatedLine, originalLines.length - 1);
      
      generator.addMapping({
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
  }

  return generator.toString();
}

/**
 * 保存source map到文件
 * @param sourceMap source map的JSON字符串
 * @param outputPath 输出文件路径
 */
export async function saveSourceMap(
  sourceMap: string,
  outputPath: string
): Promise<void> {
  await fs.writeFile(outputPath, sourceMap, 'utf-8');
}

/**
 * 为生成的JS文件添加source map引用注释
 * @param generatedCode 生成的代码
 * @param sourceMapFile source map文件名
 * @returns 添加了source map引用的代码
 */
export function addSourceMapReference(
  generatedCode: string,
  sourceMapFile: string
): string {
  return `${generatedCode}\n//# sourceMappingURL=${sourceMapFile}`;
} 