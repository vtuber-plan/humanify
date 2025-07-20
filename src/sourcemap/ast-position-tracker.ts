import * as t from '@babel/types';
import { NodePath } from '@babel/core';
import { TokenMapping } from './sourcemap-generator.js';
import { ScopeAwareMappingGenerator } from './scope-aware-mapping.js';
import { verbose } from '../verbose.js';

/**
 * AST节点位置跟踪器
 * 用于在Babel变换过程中记录原始代码和生成代码之间的位置映射
 */
export class ASTPositionTracker {
  public scopeAwareMappingGenerator: ScopeAwareMappingGenerator;
  public originalCode: string;
  
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
   * 根据生成的代码生成精确映射
   * @param generatedCode 生成的代码
   */
  generateMappings(generatedCode: string): TokenMapping[] {
    return this.scopeAwareMappingGenerator.generateMappings(this.originalCode, generatedCode);
  }

  /**
   * 清空映射记录
   */
  clear(): void {
    this.scopeAwareMappingGenerator.clear();
  }

  /**
   * 获取tracker状态，用于保存到ResumeState
   */
  getTrackerState(filePath: string): {
    filePath: string;
    originalCode: string;
    renameRecords: Array<{
      originalName: string;
      newName: string;
      scopeId: string;
      line: number;
      column: number;
    }>;
  } {
    return {
      filePath,
      originalCode: this.originalCode,
      renameRecords: this.scopeAwareMappingGenerator.getRenameRecords()
    };
  }

  /**
   * 从tracker状态恢复
   */
  restoreFromTrackerState(trackerState: {
    filePath: string;
    originalCode: string;
    renameRecords: Array<{
      originalName: string;
      newName: string;
      scopeId: string;
      line: number;
      column: number;
    }>;
  }): void {
    this.originalCode = trackerState.originalCode;
    
    // 清空现有状态
    this.scopeAwareMappingGenerator.clear();
    
    // 恢复重命名记录
    for (const record of trackerState.renameRecords) {
      this.scopeAwareMappingGenerator.recordRename(
        record.originalName,
        record.newName,
        record.scopeId,
        record.line,
        record.column
      );
    }
  }
}

/**
 * 文件跟踪器管理器
 * 为每个文件维护独立的跟踪器实例
 */
class TrackerManager {
  private trackers: Map<string, ASTPositionTracker> = new Map();

  /**
   * 为指定文件创建跟踪器
   */
  createTracker(filePath: string, originalCode: string): ASTPositionTracker {
    const tracker = new ASTPositionTracker(originalCode);
    this.trackers.set(filePath, tracker);
    return tracker;
  }

  /**
   * 获取指定文件的跟踪器
   */
  getTracker(filePath: string): ASTPositionTracker | undefined {
    return this.trackers.get(filePath);
  }

  /**
   * 清理指定文件的跟踪器
   */
  clearTracker(filePath: string): void {
    const tracker = this.trackers.get(filePath);
    if (tracker) {
      tracker.clear();
      this.trackers.delete(filePath);
    }
  }

  /**
   * 清理所有跟踪器
   */
  clearAllTrackers(): void {
    for (const [filePath, tracker] of this.trackers) {
      tracker.clear();
    }
    this.trackers.clear();
  }

  /**
   * 获取当前活跃的跟踪器数量
   */
  getActiveTrackerCount(): number {
    return this.trackers.size;
  }

  /**
   * 获取所有活跃的文件路径
   */
  getActiveFilePaths(): string[] {
    return Array.from(this.trackers.keys());
  }

  /**
   * 获取指定文件的tracker状态
   */
  getTrackerState(filePath: string): {
    filePath: string;
    originalCode: string;
    renameRecords: Array<{
      originalName: string;
      newName: string;
      scopeId: string;
      line: number;
      column: number;
    }>;
  } | null {
    const tracker = this.trackers.get(filePath);
    return tracker ? tracker.getTrackerState(filePath) : null;
  }

  /**
   * 从tracker状态恢复跟踪器
   */
  restoreTrackerFromState(trackerState: {
    filePath: string;
    originalCode: string;
    renameRecords: Array<{
      originalName: string;
      newName: string;
      scopeId: string;
      line: number;
      column: number;
    }>;
  }): ASTPositionTracker {
    const tracker = new ASTPositionTracker(trackerState.originalCode);
    tracker.restoreFromTrackerState(trackerState);
    this.trackers.set(trackerState.filePath, tracker);
    return tracker;
  }
}

/**
 * 全局跟踪器管理器实例
 */
const trackerManager = new TrackerManager();

/**
 * 为指定文件初始化跟踪器
 */
export function initializeTracker(filePath: string, originalCode: string): ASTPositionTracker {
  return trackerManager.createTracker(filePath, originalCode);
}

/**
 * 获取指定文件的跟踪器
 */
export function getTracker(filePath: string): ASTPositionTracker | undefined {
  return trackerManager.getTracker(filePath);
}

/**
 * 清理指定文件的跟踪器
 */
export function clearTracker(filePath: string): void {
  trackerManager.clearTracker(filePath);
}

/**
 * 清理所有跟踪器
 */
export function clearAllTrackers(): void {
  trackerManager.clearAllTrackers();
}

/**
 * 获取跟踪器管理器统计信息
 */
export function getTrackerStats(): {
  activeTrackerCount: number;
  activeFilePaths: string[];
} {
  return {
    activeTrackerCount: trackerManager.getActiveTrackerCount(),
    activeFilePaths: trackerManager.getActiveFilePaths()
  };
}

/**
 * 获取指定文件的tracker状态
 */
export function getTrackerState(filePath: string): {
  filePath: string;
  originalCode: string;
  renameRecords: Array<{
    originalName: string;
    newName: string;
    scopeId: string;
    line: number;
    column: number;
  }>;
} | null {
  return trackerManager.getTrackerState(filePath);
}

/**
 * 从tracker状态恢复跟踪器
 */
export function restoreTrackerFromState(trackerState: {
  filePath: string;
  originalCode: string;
  renameRecords: Array<{
    originalName: string;
    newName: string;
    scopeId: string;
    line: number;
    column: number;
  }>;
}): ASTPositionTracker {
  return trackerManager.restoreTrackerFromState(trackerState);
} 