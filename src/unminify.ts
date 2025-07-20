import fs from "fs/promises";
import path from "path";
import { ensureFileExists } from "./file-utils.js";
import { webcrack } from "./plugins/webcrack.js";
import { verbose } from "./verbose.js";
import { 
  generateSourceMap, 
  saveSourceMap, 
  addSourceMapReference,
  SourceMapOptions 
} from "./sourcemap/sourcemap-generator.js";
import { initializeTracker, clearTracker, getTracker, getTrackerState } from "./sourcemap/ast-position-tracker.js";

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

    // 如果启用source map，初始化位置跟踪器
    let tracker = null;
    if (options.generateSourceMap) {
      tracker = initializeTracker(file.path, originalCode);
    }

    // 应用所有插件，传递source map启用标志和文件路径
    const formattedCode = await plugins.reduce(
      (p, next) => p.then(code => next(code, file.path)),
      Promise.resolve(originalCode)
    );

    verbose.log("Input: ", originalCode);
    verbose.log("Output: ", formattedCode);

    // 生成source map（如果启用）
    if (options.generateSourceMap && tracker) {
      const sourceMapOptions: SourceMapOptions = {
        originalFile: file.path,
        generatedFile: file.path,
        outputDir: outputDir
      };

      // 调试：检查tracker状态
      const trackerState = getTrackerState(file.path);
      verbose.log(`Before generating source map, tracker has ${trackerState?.renameRecords?.length || 0} rename records`);

      // 使用跟踪器生成精确的映射
      const mappings = tracker.generateMappings(formattedCode);
      verbose.log(`Generated ${mappings.length} mappings for source map`);
      const sourceMapContent = await generateSourceMap(
        originalCode,
        formattedCode,
        sourceMapOptions,
        mappings
      );

      const sourceMapFileName = `${path.basename(file.path)}.map`;
      const sourceMapPath = path.join(outputDir, sourceMapFileName);

      await saveSourceMap(sourceMapContent, sourceMapPath);

      console.log(`Generated source map: ${sourceMapPath} with ${mappings.length} mappings`);
      
      // 清理跟踪器
      clearTracker(file.path);
    }

    // 为生成的代码添加source map引用（在所有插件处理完成后）
    await fs.writeFile(file.path, formattedCode);
  }

  console.log(`Done! You can find your unminified code in ${outputDir}`);
}
