import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

export interface ResumeState {
  code: string;
  renames: string[];
  visited: string[];
  currentIndex: number;
  totalScopes: number;
  codePath: string;
}

const RESUME_STATE_SUFFIX = ".humanify-resume.json";

function isResumeState(value: unknown): value is ResumeState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const state = value as ResumeState;
  return (
    typeof state.code === "string" &&
    Array.isArray(state.renames) &&
    Array.isArray(state.visited) &&
    typeof state.currentIndex === "number" &&
    typeof state.totalScopes === "number" &&
    typeof state.codePath === "string"
  );
}

export function resolveResumeStatePath(codePath: string): string {
  const normalizedPath = path.resolve(codePath);
  const hash = crypto
    .createHash("md5")
    .update(normalizedPath)
    .digest("hex")
    .slice(0, 8);
  const baseName = path.basename(normalizedPath);
  return path.join(path.dirname(normalizedPath), `.${baseName}.${hash}${RESUME_STATE_SUFFIX}`);
}

export function resolveResumeSessionPath(resumePath: string, filePath?: string): string {
  if (!filePath) {
    return resolveResumeStatePath(resumePath);
  }

  const normalizedResumePath = path.resolve(resumePath);
  const normalizedFilePath = path.resolve(filePath);
  const hash = crypto
    .createHash("md5")
    .update(`${normalizedResumePath}::${normalizedFilePath}`)
    .digest("hex")
    .slice(0, 8);
  const baseName = path.basename(normalizedResumePath);
  return path.join(path.dirname(normalizedResumePath), `.${baseName}.${hash}${RESUME_STATE_SUFFIX}`);
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
    const parsed = JSON.parse(content);
    if (!isResumeState(parsed)) {
      return null;
    }
    return parsed;
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
