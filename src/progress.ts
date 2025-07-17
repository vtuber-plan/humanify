import { Readable } from "stream";
import { verbose } from "./verbose.js";

export function showProgress(stream: Readable) {
  let bytes = 0;
  let i = 0;
  stream.on("data", (data) => {
    bytes += data.length;
    if (i++ % 1000 !== 0) return;
    process.stdout.clearLine?.(0);
    process.stdout.write(`\rDownloaded ${formatBytes(bytes)}`);
  });
}

function formatBytes(numBytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unitIndex = 0;
  while (numBytes > 1024 && unitIndex < units.length) {
    numBytes /= 1024;
    unitIndex++;
  }
  return `${numBytes.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * 显示百分比进度和预计剩余时间（ETA）。
 * @param percentage 进度百分比（0~1）
 * @param startTime 任务开始时间（Date.now()）
 */
export function showPercentage(percentage: number, startTime?: number) {
  const percentageStr = (percentage * 100).toFixed(2);
  let etaStr = "";
  if (startTime && percentage > 0 && percentage < 1) {
    const elapsed = (Date.now() - startTime) / 1000; // 秒
    const total = elapsed / percentage;
    const remaining = Math.max(0, total - elapsed);
    etaStr = `，预计剩余 ${formatTime(remaining)}`;
  }
  if (!verbose.enabled) {
    process.stdout.clearLine?.(0);
    process.stdout.cursorTo(0);
    process.stdout.write(`Processing: ${percentageStr}%${etaStr}`);
  } else {
    verbose.log(`Processing: ${percentageStr}%${etaStr}`);
  }
  if (percentage === 1) {
    process.stdout.write("\n");
  }
}

function formatTime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  } else {
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
}
