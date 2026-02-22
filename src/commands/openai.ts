import { cli } from "../cli.js";
import prettier from "../plugins/prettier.js";
import { unminify } from "../unminify.js";
import babel from "../plugins/babel/babel.js";
import { openaiRename } from "../plugins/openai/openai-rename.js";
import { openaiBatchRename } from "../plugins/openai/openai-batch-rename.js";
import { verbose } from "../verbose.js";
import { env } from "../env.js";
import { parseNumber, parsePositiveNumber } from "../number-utils.js";
import { DEFAULT_CONTEXT_WINDOW_SIZE } from "./default-args.js";

export const openai = cli()
  .name("openai")
  .description("Use OpenAI's API to unminify code")
  .option("-m, --model <model>", "The model to use", "gpt-4o-mini")
  .option("-o, --outputDir <output>", "The output directory", "output")
  .option(
    "-k, --apiKey <apiKey>",
    "The OpenAI API key. Alternatively use OPENAI_API_KEY environment variable"
  )
  .option(
    "--baseURL <baseURL>",
    "The OpenAI base server URL.",
    env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1"
  )
  .option("--verbose", "Show verbose output")
  .option(
    "--contextSize <contextSize>",
    "The context size to use for the LLM",
    `${DEFAULT_CONTEXT_WINDOW_SIZE}`
  )
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
    "--batchConcurrency <batchConcurrency>",
    "Number of concurrent LLM requests in batch mode (default: 1)",
    "1"
  )
  .option(
    "--smallScopeMergeLimit <smallScopeMergeLimit>",
    "Auto-merge scopes with <= N identifiers into larger batches; 0 disables merge (default: 2)",
    "2"
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

    const apiKey = opts.apiKey ?? env("OPENAI_API_KEY");
    const baseURL = opts.baseURL;
    const contextWindowSize = parseNumber(opts.contextSize);
    const batchSize = parsePositiveNumber(opts.batchSize, "batchSize");
    const batchConcurrency = parsePositiveNumber(opts.batchConcurrency, "batchConcurrency");
    const smallScopeMergeLimit = parseNumber(opts.smallScopeMergeLimit);
    
    // 根据batch参数选择使用普通重命名还是批量重命名
    const renameFunction = opts.batch 
      ? openaiBatchRename({
          apiKey,
          baseURL,
          model: opts.model,
          contextWindowSize,
          resume: opts.resume,
          batchSize,
          batchConcurrency,
          smallScopeMergeLimit,
          systemPrompt: opts.systemPrompt,
          uniqueNames: opts.uniqueNames
        })
      : openaiRename({
          apiKey,
          baseURL,
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
      (code: string, filePath?: string) => renameFunction(code, filePath),
      (code: string) => prettier(code)
    ], {
      generateSourceMap: opts.sourcemap
    });
  });
