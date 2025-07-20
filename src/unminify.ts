import fs from "fs/promises";
import path from "path";
import { ensureFileExists } from "./file-utils.js";
import { webcrack } from "./plugins/webcrack.js";
import { verbose } from "./verbose.js";

export interface UnminifyOptions {
  generateSourceMap?: boolean;
}

export async function unminify(
  filename: string,
  outputDir: string,
  plugins: ((code: string, filePath?: string) => Promise<string>)[] = [],
  options: UnminifyOptions = {}
) {
  ensureFileExists(filename);
  const bundledCode = await fs.readFile(filename, "utf-8");
  const extractedFiles = await webcrack(bundledCode, outputDir);

  verbose.log("Extracted files: ", extractedFiles);

  for (let i = 0; i < extractedFiles.length; i++) {
    console.log(`Processing file ${i + 1}/${extractedFiles.length}`);

    const file = extractedFiles[i];
    const originalCode = await fs.readFile(file.path, "utf-8");

    if (originalCode.trim().length === 0) {
      verbose.log(`Skipping empty file ${file.path}`);
      continue;
    }


    // 应用所有插件，传递source map启用标志和文件路径
    const formattedCode = await plugins.reduce(
      (p, next) => p.then(code => next(code, file.path)),
      Promise.resolve(originalCode)
    );

    verbose.log("Input: ", originalCode);
    verbose.log("Output: ", formattedCode);

    // 为生成的代码添加source map引用（在所有插件处理完成后）
    await fs.writeFile(file.path, formattedCode);
  }

  console.log(`Done! You can find your unminified code in ${outputDir}`);
}
