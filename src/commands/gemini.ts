import { cli } from "../cli.js";
import prettier from "../plugins/prettier.js";
import { unminify } from "../unminify.js";
import babel from "../plugins/babel/babel.js";
import { verbose } from "../verbose.js";
import { geminiRename } from "../plugins/gemini/gemini-rename.js";
import { geminiBatchRename } from "../plugins/gemini/gemini-batch-rename.js";
import { env } from "../env.js";
import { DEFAULT_CONTEXT_WINDOW_SIZE } from "./default-args.js";
import { parseNumber, parsePositiveNumber } from "../number-utils.js";

export const azure = cli()
  .name("gemini")
  .description("Use Google Gemini/AIStudio API to unminify code")
  .option("-m, --model <model>", "The model to use", "gemini-1.5-flash")
  .option("-o, --outputDir <output>", "The output directory", "output")
  .option(
    "--contextSize <contextSize>",
    "The context size to use for the LLM",
    `${DEFAULT_CONTEXT_WINDOW_SIZE}`
  )
  .option(
    "-k, --apiKey <apiKey>",
    "The Google Gemini/AIStudio API key. Alternatively use GEMINI_API_KEY environment variable"
  )
  .option("--verbose", "Show verbose output")
  .option(
    "--resume <resume>",
    "Path to the code file being processed. Humanify stores resume state in a safe sidecar file next to it",
    undefined
  )
  .option("--sourcemap", "Generate source map files mapping original to deobfuscated code", false)
  .option("--unique-names", "Ensure output variable names are unique by adding numeric suffixes", false)
  .option("--batch", "Enable batch renaming mode for more efficient processing", false)
  .option(
    "--batchSize <batchSize>",
    "Maximum number of variables to rename in a single batch (default: 10)",
    "10"
  )
  .option(
    "--systemPrompt <systemPrompt>",
    "Custom system prompt to describe the project context and purpose for better variable renaming",
    undefined
  )
  .argument("input", "The input minified Javascript file")
  .action(async (filename, opts) => {
    if (opts.verbose) {
      verbose.enabled = true;
    }

    const apiKey = opts.apiKey ?? env("GEMINI_API_KEY");
    const contextWindowSize = parseNumber(opts.contextSize);
    const batchSize = parsePositiveNumber(opts.batchSize, "batchSize");

    // 根据batch参数选择使用普通重命名还是批量重命名
    const renameFunction = opts.batch 
      ? geminiBatchRename({
          apiKey, 
          model: opts.model, 
          contextWindowSize,
          resume: opts.resume,
          batchSize,
          systemPrompt: opts.systemPrompt,
          uniqueNames: opts.uniqueNames
        })
      : geminiRename({ 
          apiKey, 
          model: opts.model, 
          contextWindowSize,
          resume: opts.resume,
          systemPrompt: opts.systemPrompt,
          uniqueNames: opts.uniqueNames
        });

    if (opts.batch) {
      verbose.log("Using batch renaming mode");
    } else {
      verbose.log("Using standard renaming mode");
    }

    await unminify(filename, opts.outputDir, [
      (code: string, filePath?: string) => babel(code, opts.sourcemap, filePath),
      (code: string) => renameFunction(code),
      (code: string) => prettier(code)
    ], {
      generateSourceMap: opts.sourcemap
    });
  });
