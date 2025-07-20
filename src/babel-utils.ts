import { transform, PluginItem } from "@babel/core";

export interface TransformOptions {
  enableSourceMap?: boolean;
  retainLines?: boolean;
  filePath?: string; // 添加文件路径参数
}

export const transformWithPlugins = async (
  code: string,
  plugins: PluginItem[],
  options: TransformOptions = {}
): Promise<string> => {

  return await new Promise((resolve, reject) =>
    transform(
      code,
      {
        plugins,
        compact: false,
        minified: false,
        comments: false,
        sourceMaps: options.enableSourceMap ? "inline" : false,
        retainLines: options.retainLines || options.enableSourceMap || false,
        // 保持原始位置信息用于source map生成
        parserOpts: {
          ranges: true
        }
      },
      (err, result) => {
        if (err || !result) {
          reject(err);
        } else {
          // source map跟踪在unminify.ts中处理，这里不需要做任何事情
          resolve(result.code as string);
        }
      }
    )
  );
};
