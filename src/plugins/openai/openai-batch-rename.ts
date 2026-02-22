import OpenAI from "openai";
import { batchVisitAllIdentifiersGrouped } from "../local-llm-rename/batch-visit-all-indentifiers.js";
import { showPercentage } from "../../progress.js";
import { verbose } from "../../verbose.js";

import { createClientOptions } from "../../proxy-utils.js";

const STREAM_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_JSON_RETRY_ATTEMPTS = 3;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export function openaiBatchRename({
  apiKey,
  baseURL,
  model,
  contextWindowSize,
  resume = undefined,
  batchSize = 10,
  batchConcurrency = 1,
  smallScopeMergeLimit = 2,
  systemPrompt = undefined,
  uniqueNames = false,
}: {
  apiKey: string;
  baseURL: string;
  model: string;
  contextWindowSize: number;
  resume?: string;
  batchSize?: number;
  batchConcurrency?: number;
  smallScopeMergeLimit?: number;
  systemPrompt?: string;
  uniqueNames?: boolean;
}) {
  const clientOptions = createClientOptions(baseURL, {
    apiKey,
    baseURL,
    timeout: STREAM_TIMEOUT_MS
  });
  const client = new OpenAI(clientOptions);

  return async (code: string, filePath?: string): Promise<string> => {
    const startTime = Date.now();
    return await batchVisitAllIdentifiersGrouped(
      code,
      async (names, surroundingCode) => {
        verbose.log(`Batch renaming: ${names.join(", ")}`);
        verbose.log("Context: ", surroundingCode);
        
        // if xxx = "", use regex
        if (surroundingCode.trim().match(/^[a-zA-Z0-9_]+ = "\s*"/)) {
          return {};
        }

        // if xxx = {}, use regex
        if (surroundingCode.trim().match(/^[a-zA-Z0-9_]+ = \{\s*\}$/)) {
          return {};
        }

        // if [xxx], use regex
        if (surroundingCode.trim().match(/^\[[a-zA-Z0-9_]+\]$/)) {
          return {};
        }

        // if function U() {}, use regex
        if (surroundingCode.trim().match(/^function [a-zA-Z0-9_]+\(\) \{\s*\}$/)) {
          return {};
        }

        // if function U(xxx) {}, use regex
        if (surroundingCode.trim().match(/^function [a-zA-Z0-9_]+\([a-zA-Z0-9_]+\) \{\s*\}$/)) {
          return {};
        }

        // if class Ou {}, use regex
        if (surroundingCode.trim().match(/^class [a-zA-Z0-9_]+\s*\{\s*\}$/)) {
          return {};
        }

        // if catch (xxx) {}
        if (surroundingCode.trim().match(/^catch \([a-zA-Z0-9_]+\) \{\s*\}$/)) {
          return {};
        }


        // context too small if , 例如E = {}，[A]，D=[]
        if (surroundingCode.replace(/\s/g, '').length < 10) {
          return {};
        }

        function createIdentityRenameMap(targetNames: string[]): Record<string, string> {
          const fallback: Record<string, string> = {};
          for (const name of targetNames) {
            fallback[name] = name;
          }
          return fallback;
        }

        function normalizeRenameMap(parsed: unknown, targetNames: string[]): Record<string, string> | null {
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
          }

          const source = parsed as Record<string, unknown>;
          const map: Record<string, string> = {};

          for (const name of targetNames) {
            const value = source[name];
            map[name] = typeof value === "string" && value.trim().length > 0 ? value.trim() : name;
          }

          return map;
        }

        function extractBalancedJsonObject(text: string): string | null {
          const start = text.indexOf("{");
          if (start < 0) {
            return null;
          }

          let depth = 0;
          let inString = false;
          let escaping = false;

          for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (inString) {
              if (escaping) {
                escaping = false;
              } else if (ch === "\\") {
                escaping = true;
              } else if (ch === "\"") {
                inString = false;
              }
              continue;
            }

            if (ch === "\"") {
              inString = true;
              continue;
            }

            if (ch === "{") {
              depth++;
            } else if (ch === "}") {
              depth--;
              if (depth === 0) {
                return text.slice(start, i + 1);
              }
            }
          }

          return null;
        }

        function parseLooseKeyValueMap(text: string, targetNames: string[]): Record<string, string> | null {
          const kvRegex = /["']?([A-Za-z_$][\w$]*)["']?\s*:\s*["']([^"'\r\n]+)["']/g;
          const found = new Map<string, string>();
          let match: RegExpExecArray | null;

          while ((match = kvRegex.exec(text)) !== null) {
            const key = match[1];
            const value = match[2];

            if (targetNames.includes(key) && value.trim().length > 0) {
              found.set(key, value.trim());
            }
          }

          if (found.size === 0) {
            return null;
          }

          const map: Record<string, string> = {};
          for (const name of targetNames) {
            map[name] = found.get(name) ?? name;
          }

          return map;
        }

        function extractBatchJsonResponse(result: string, targetNames: string[]): Record<string, string> {
          const raw = result.trim();
          const candidates: string[] = [];

          if (raw.length > 0) {
            candidates.push(raw);
          }

          const fencedRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
          for (const match of raw.matchAll(fencedRegex)) {
            const inner = match[1]?.trim();
            if (inner) {
              candidates.push(inner);
            }
          }

          const balanced = extractBalancedJsonObject(raw);
          if (balanced) {
            candidates.push(balanced);
          }

          for (const candidate of candidates) {
            try {
              const parsed = JSON.parse(candidate);
              const normalized = normalizeRenameMap(parsed, targetNames);
              if (normalized) {
                verbose.log("Extracted JSON string:", candidate);
                return normalized;
              }
            } catch {
              // try next candidate
            }
          }

          const loose = parseLooseKeyValueMap(raw, targetNames);
          if (loose) {
            verbose.log("Recovered rename map using loose key-value parser.");
            return loose;
          }

          verbose.log("Failed to parse response:", raw);
          throw new Error("Failed to parse JSON response");
        }

        async function getBatchRenamed(promptParams: { names: string[]; surroundingCode: string; model: string; extraPrompt?: string; systemPrompt?: string }): Promise<Record<string, string>> {
          const baseRequestParams = toBatchRenamePrompt(
            promptParams.names,
            promptParams.surroundingCode,
            promptParams.model,
            promptParams.extraPrompt,
            promptParams.systemPrompt
          );

          let lastError: unknown;
          for (let attempt = 0; attempt < MAX_JSON_RETRY_ATTEMPTS; attempt++) {
            const streamMode = attempt < MAX_JSON_RETRY_ATTEMPTS - 1;
            try {
              if (streamMode) {
                const stream = await withTimeout(
                  client.chat.completions.create({
                    ...baseRequestParams,
                    stream: true
                  } as any),
                  STREAM_TIMEOUT_MS,
                  "Stream request timeout before first chunk after 5 minutes"
                );

                let fullContent = "";
                const iterator = (stream as any)[Symbol.asyncIterator]();
                try {
                  while (true) {
                    const nextChunk = await withTimeout(
                      iterator.next(),
                      STREAM_TIMEOUT_MS,
                      "Stream timeout waiting for chunk after 5 minutes"
                    );

                    if (nextChunk.done) {
                      break;
                    }

                    const chunk = nextChunk.value;
                    const content = chunk.choices[0]?.delta?.content || "";
                    if (content) {
                      fullContent += content;
                    }
                  }
                } finally {
                  await iterator.return?.();
                }

                verbose.log("Stream result:", fullContent);
                return extractBatchJsonResponse(fullContent, promptParams.names);
              }

              const completion = await withTimeout(
                client.chat.completions.create({
                  ...baseRequestParams,
                  stream: false
                } as any),
                STREAM_TIMEOUT_MS,
                "Non-stream request timeout after 5 minutes"
              );
              const content = completion.choices?.[0]?.message?.content ?? "";
              verbose.log("Non-stream result:", content);
              return extractBatchJsonResponse(content, promptParams.names);
            } catch (error) {
              lastError = error;
              verbose.log(`Batch rename parse attempt ${attempt + 1} failed:`, error);
            }
          }

          throw lastError instanceof Error ? lastError : new Error("Batch rename failed");
        }

        let renameMap: Record<string, string>;
        try {
          renameMap = await getBatchRenamed({ names, surroundingCode, model, systemPrompt });
        } catch (error) {
          // 如果第一次解析失败，重新发给LLM让其只返回JSON
          verbose.log("Error parsing response:", error);
          verbose.log("Retrying with format correction prompt...");
          const formatPrompt = `请将下面的内容仅以JSON格式输出，且**不要包含任何多余的内容**，只返回JSON对象!!!`;
          try {
            renameMap = await getBatchRenamed({ names, surroundingCode, model, extraPrompt: formatPrompt, systemPrompt });
          } catch (error2) {
            verbose.log("Failed again to parse response after retry. Falling back to identity map.");
            renameMap = createIdentityRenameMap(names);
          }
        }

        verbose.log(`Batch renamed:`, renameMap);

        return renameMap;
      },
      contextWindowSize,
      (percentage) => showPercentage(percentage, startTime),
      resume,
      batchSize,
      filePath,
      16, // minInformationScore
      uniqueNames,
      batchConcurrency,
      50, // dirtyCheckpointInterval
      smallScopeMergeLimit
    );
  };
}

const browserGlobals = ["window", "document", "console", "navigator", "screen", "location", "history"];
const nodeGlobals = ["global", "process", "console", "Buffer"];
const commonGlobals = ["Math", "Date", "JSON", "Array", "Object", "String", "encodeURI", "decodeURI", "setTimeout", "setInterval", "eval"];
const allGlobals = [...browserGlobals, ...nodeGlobals, ...commonGlobals];

function toBatchRenamePrompt(
  names: string[],
  surroundingCode: string,
  model: string,
  extraPrompt?: string,
  systemPrompt?: string
): OpenAI.Chat.Completions.ChatCompletionCreateParams {
  const exampleEntries = names
    .slice(0, 2)
    .map((name, index) => `          "${name}": "newName${index + 1}"`)
    .join(",\n");
  const exampleTail = names.length > 2 ? `,\n          ...` : "";

  let userContent = `Rename the following Javascript variables/functions: \`${names.join(", ")}\` to have descriptive names based on their usage in the code.
        Here is the surrounding code:
        \`\`\`javascript
        ${surroundingCode}
        \`\`\`

        Note:
        1. If the name is not obfuscated, please keep the name as is. (such as ${allGlobals.join(", ")})
        2. If the name is obfuscated, please rename it.
        3. Please provide the new names in the response as a JSON object mapping original names to new names.
        The response should be a valid JSON string with the format:
        \`\`\`json
        {
${exampleEntries}${exampleTail}
        }
        \`\`\`
        
        Make sure to rename all the variables/functions in the list and return a complete mapping.
        Return ONLY a JSON object. Do not add markdown fences or any extra text.
        `;
  if (extraPrompt) {
    userContent += `\n${extraPrompt}`;
  }
  const defaultSystemPrompt = `You are a helpful assistant that renames Javascript variables and functions to have more descriptive names based on their usage in the code.
        You will be given multiple variable or function names and the surrounding code context, and you should rename all of them at once.`;
        
  const finalSystemPrompt = systemPrompt ? `${systemPrompt}\n\n${defaultSystemPrompt}` : defaultSystemPrompt;
        
  return {
    model,
    messages: [
      {
        role: "system",
        content: finalSystemPrompt
      },
      {
        role: "user",
        content: userContent
      }
    ]
  };
}
