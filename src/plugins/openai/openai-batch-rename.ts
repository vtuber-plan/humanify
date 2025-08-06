import OpenAI from "openai";
import { batchVisitAllIdentifiersGrouped } from "../local-llm-rename/batch-visit-all-indentifiers.js";
import { showPercentage } from "../../progress.js";
import { verbose } from "../../verbose.js";

import { createClientOptions } from "../../proxy-utils.js";

export function openaiBatchRename({
  apiKey,
  baseURL,
  model,
  contextWindowSize,
  resume = undefined,
  batchSize = 10,
  systemPrompt = undefined,
  uniqueNames = false,
}: {
  apiKey: string;
  baseURL: string;
  model: string;
  contextWindowSize: number;
  resume?: string;
  batchSize?: number;
  systemPrompt?: string;
  uniqueNames?: boolean;
}) {
  const clientOptions = createClientOptions(baseURL, {
    apiKey,
    baseURL,
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

        async function getBatchRenamed(promptParams: { names: string[]; surroundingCode: string; model: string; extraPrompt?: string; systemPrompt?: string }, rawResult?: string): Promise<Record<string, string>> {
          if (rawResult) {
            return extractBatchJsonResponse(rawResult);
          }

          const requestParams: any = {
            ...toBatchRenamePrompt(promptParams.names, promptParams.surroundingCode, promptParams.model, promptParams.extraPrompt, promptParams.systemPrompt),
            stream: true,
          };

          const stream = await client.chat.completions.create(requestParams);

          let fullContent = "";
          const timeoutMs = 5 * 60 * 1000; // 5分钟超时
          const startTime = Date.now();

          try {
            for await (const chunk of stream as any) {
              if (Date.now() - startTime > timeoutMs) {
                throw new Error("Stream timeout after 5 minutes");
              }

              const content = chunk.choices[0]?.delta?.content || "";
              if (content) {
                fullContent += content;
              }
            }

            verbose.log("Stream result:", fullContent);
            return extractBatchJsonResponse(fullContent);
          } catch (error) {
            verbose.log("Stream error:", error);
            throw error;
          }
        }

        function extractBatchJsonResponse(result: string): Record<string, string> {
          let jsonStr = result.trim();

          if (jsonStr.includes('```')) {
            // 提取```json ...```或``` ...```中的内容，只取代码块内的内容
            const match = jsonStr.match(/```[a-z]*\s*([\s\S]*?)\s*```/i);
            if (match && match[1]) {
              jsonStr = match[1].trim();
              verbose.log("Extracted JSON string:", jsonStr);
            }
          }

          try {
            const parsed = JSON.parse(jsonStr);
            // 确保返回的是对象格式 {originalName: newName}
            if (typeof parsed === 'object' && parsed !== null) {
              return parsed;
            } else {
              throw new Error("Response is not a valid object");
            }
          } catch (error) {
            verbose.log("Failed to parse response:", jsonStr);
            throw error;
          }
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
            verbose.log("Failed again to parse response after retry.");
            throw new Error("Failed to parse response after retry", { cause: error2 });
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
      uniqueNames
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
          "${names[0]}": "newName1",
          "${names[1]}": "newName2",
          ...
        }
        \`\`\`
        
        Make sure to rename all the variables/functions in the list and return a complete mapping.
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
