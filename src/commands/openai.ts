import { cli } from "../cli.js";
import prettier from "../plugins/prettier.js";
import { unminify } from "../unminify.js";
import babel from "../plugins/babel/babel.js";
import { openaiRename } from "../plugins/openai/openai-rename.js";
import { openaiBatchRename } from "../plugins/openai/openai-batch-rename.js";
import { verbose } from "../verbose.js";
import { env } from "../env.js";
import { parseNumber } from "../number-utils.js";
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
    "The path to the code file being processed, used for resuming. Providing this automatically enables resume mode",
    undefined
  )
  .option("--sourcemap", "Generate source map files mapping original to deobfuscated code", false)
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

    const apiKey = opts.apiKey ?? env("OPENAI_API_KEY");
    const baseURL = opts.baseURL;
    const contextWindowSize = parseNumber(opts.contextSize);
    const batchSize = parseNumber(opts.batchSize);
    
    // 根据batch参数选择使用普通重命名还是批量重命名
    const renameFunction = opts.batch 
      ? openaiBatchRename({
          apiKey,
          baseURL,
          model: opts.model,
          contextWindowSize,
          resume: opts.resume,
          batchSize,
          systemPrompt: opts.systemPrompt
        })
      : openaiRename({
          apiKey,
          baseURL,
          model: opts.model,
          contextWindowSize,
          resume: opts.resume,
          systemPrompt: opts.systemPrompt
        });

    if (opts.batch) {
      verbose.log("Using batch renaming mode");
    } else {
      verbose.log("Using standard renaming mode");
    }

    await unminify(filename, opts.outputDir, [
      (code: string, filePath?: string) => babel(code, false, filePath),
      (code: string) => renameFunction(code),
      (code: string) => prettier(code)
    ], {
      generateSourceMap: opts.sourcemap
    });
  });
