#!/usr/bin/env -S npx tsx
import packageJson from "../package.json" with { type: "json" };
import { download } from "./commands/download.js";
import { local } from "./commands/local.js";
import { openai } from "./commands/openai.js";
import { anthropic } from "./commands/anthropic.js";
import { cli } from "./cli.js";
import { azure } from "./commands/gemini.js";

cli()
  .name("humanify")
  .description("Unminify code using OpenAI's API or a local LLM")
  .version(packageJson.version)
  .addCommand(local)
  .addCommand(openai)
  .addCommand(anthropic)
  .addCommand(azure)
  .addCommand(download())
  .parse(process.argv);
