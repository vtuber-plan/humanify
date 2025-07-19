import { cli } from "../cli.js";
import { llama } from "../plugins/local-llm-rename/llama.js";
import { DEFAULT_MODEL } from "../local-models.js";
import { unminify } from "../unminify.js";
import prettier from "../plugins/prettier.js";
import babel from "../plugins/babel/babel.js";
import { localReanme } from "../plugins/local-llm-rename/local-llm-rename.js";
import { verbose } from "../verbose.js";
import { DEFAULT_CONTEXT_WINDOW_SIZE } from "./default-args.js";
import { parseNumber } from "../number-utils.js";

export const local = cli()
  .name("local")
  .description("Use a local LLM to unminify code")
  .showHelpAfterError(true)
  .option("-m, --model <model>", "The model to use", DEFAULT_MODEL)
  .option("-o, --outputDir <output>", "The output directory", "output")
  .option(
    "-s, --seed <seed>",
    "Seed for the model to get reproduceable results (leave out for random seed)"
  )
  .option("--disableGpu", "Disable GPU acceleration")
  .option("--verbose", "Show verbose output")
  .option(
    "--contextSize <contextSize>",
    "The context size to use for the LLM",
    `${DEFAULT_CONTEXT_WINDOW_SIZE}`
  )
  .option(
    "--resume",
    "Resume from a previous interrupted session",
    false
  )
  .option(
    "--codePath <codePath>",
    "The path to the code file being processed, used for resuming. Providing this automatically enables resume mode",
    undefined
  )
  .option("--sourcemap", "Generate source map files mapping original to deobfuscated code", false)
  .argument("input", "The input minified Javascript file")
  .action(async (filename, opts) => {
    if (opts.verbose) {
      verbose.enabled = true;
    }

    verbose.log("Starting local inference with options: ", opts);

    const contextWindowSize = parseNumber(opts.contextSize);
    const prompt = await llama({
      model: opts.model,
      disableGpu: opts.disableGpu,
      seed: opts.seed ? parseInt(opts.seed) : undefined
    });
    await unminify(filename, opts.outputDir, [
      (code: string, enableSourceMap?: boolean, filePath?: string) => babel(code, enableSourceMap, filePath),
      (code: string) => localReanme(prompt, contextWindowSize)(code, opts.resume || !!opts.codePath, opts.codePath),
      (code: string) => prettier(code)
    ], {
      generateSourceMap: opts.sourcemap
    });
  });
