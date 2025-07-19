import fs from "fs/promises";
import path from "path";

export interface ResumeState {
  code: string;
  renames: string[];
  visited: string[];
  currentIndex: number;
  totalScopes: number;
  codePath: string;
  
  // Tracker状态信息
  trackerState?: {
    filePath: string;
    originalCode: string;
    renameRecords: Array<{
      originalName: string;
      newName: string;
      scopeId: string;
      line: number;
      column: number;
    }>;
  };
}

export async function saveResumeState(
  state: ResumeState,
  savePath: string
): Promise<void> {
  // 不保存 ast
  await fs.writeFile(savePath, JSON.stringify(state, null, 2));
}

export async function loadResumeState(savePath: string): Promise<ResumeState | null> {
  try {
    const content = await fs.readFile(savePath, "utf-8");
    return JSON.parse(content) as ResumeState;
  } catch (error) {
    return null;
  }
}

export async function deleteResumeState(savePath: string): Promise<void> {
  try {
    await fs.unlink(savePath);
  } catch (error) {
    // Ignore errors when deleting
  }
}

export function generateSessionId(filePath: string): string {
  const normalizedPath = path.resolve(filePath);
  const hash = require("crypto")
    .createHash("md5")
    .update(normalizedPath)
    .digest("hex")
    .slice(0, 8);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${timestamp}_${path.basename(filePath, ".js")}_${hash}`;
}
