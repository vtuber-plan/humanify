import OpenAI from "openai";
import { batchVisitAllIdentifiers, batchVisitAllIdentifiersGrouped } from "../local-llm-rename/batch-visit-all-indentifiers.js";
import { showPercentage } from "../../progress.js";
import { verbose } from "../../verbose.js";

import { createClientOptions } from "../../proxy-utils.js";

export function openaiRename({
  apiKey,
  baseURL,
  model,
  contextWindowSize,
  resume = undefined,
}: {
  apiKey: string;
  baseURL: string;
  model: string;
  contextWindowSize: number;
  resume?: string;
}) {
  const clientOptions = createClientOptions(baseURL, {
    apiKey,
    baseURL,
  });
  const client = new OpenAI(clientOptions);

  return async (code: string): Promise<string> => {
    const startTime = Date.now();
    return await batchVisitAllIdentifiers(
      code,
      async (names, surroundingCode) => {
        verbose.log(`Renaming ${names}`);
        verbose.log("Context: ", surroundingCode);

        // 封装一次LLM请求和解析的逻辑，便于重试
        async function getRenamed(promptParams: { names: string; surroundingCode: string; model: string; extraPrompt?: string }, rawResult?: string): Promise<string> {
          if (rawResult) {
            return extractJsonResponse(rawResult);
          }

          const requestParams: any = {
            ...toRenamePrompt([promptParams.names], promptParams.surroundingCode, promptParams.model, promptParams.extraPrompt),
            stream: true,
          };

          const stream = await client.chat.completions.create(requestParams);

          let fullContent = "";
          const timeoutMs = 5 * 60 * 1000; // 5分钟超时
          const startTime = Date.now();

          try {
            for await (const chunk of stream as any) {
              if (Date.now() - startTime > timeoutMs) {
                throw new Error("Stream timeout after 30 seconds");
              }

              const content = chunk.choices[0]?.delta?.content || "";
              if (content) {
                fullContent += content;
              }
            }

            // 流结束后处理完整内容
            verbose.log("Stream result:", fullContent);
            return extractJsonResponse(fullContent);
          } catch (error) {
            verbose.log("Stream error:", error);
            throw error;
          }
        }

        function extractJsonResponse(result: string): string {
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
            return JSON.parse(jsonStr).newName;
          } catch (error) {
            verbose.log("Failed to parse response:", jsonStr);
            throw error;
          }
        }

        let renamed: string;
        try {
          renamed = await getRenamed({ names, surroundingCode, model });
        } catch (error) {
          // 如果第一次解析失败，重新发给LLM让其只返回JSON
          verbose.log("Error parsing response:", error);
          verbose.log("Retrying with format correction prompt...");
          const formatPrompt = `请将下面的内容仅以JSON格式输出，且**不要包含任何多余的内容**，只返回JSON对象!!!`;
          try {
            renamed = await getRenamed({ names, surroundingCode, model, extraPrompt: formatPrompt });
          } catch (error2) {
            verbose.log("Failed again to parse response after retry.");
            throw new Error("Failed to parse response after retry", { cause: error2 });
          }
        }

        verbose.log(`Renamed to ${renamed}`);

        // sleep(1000); // 等待1秒，避免过快请求导致API限制
        // sleep(500);

        return renamed;
      },
      contextWindowSize,
      (percentage) => showPercentage(percentage, startTime),
      resume,
    );
  };
}

function toRenamePrompt(
  names: string[],
  surroundingCode: string,
  model: string,
  extraPrompt?: string
): OpenAI.Chat.Completions.ChatCompletionCreateParams {
  let userContent = `Rename Javascript variables/function \`${names.join(", ")}\` to have descriptive name based on their usage in the code."
        Here is the surrounding code:
        \`\`\`javascript
        ${surroundingCode}
        \`\`\`

        Please provide the new name in the response as a JSON object mapping original names to new names.
        The response should be a valid JSON string.
        For example:
        \`\`\`json
        {
          "originalName1": "newName1",
          "originalName2": "newName2",
          ...
        }
        \`\`\`
        `;
  if (extraPrompt) {
    userContent += `\n${extraPrompt}`;
  }
  return {
    model,
    messages: [
      {
        role: "system",
        content: `You are a helpful assistant that renames Javascript variables and functions to have more descriptive names based on their usage in the code.
        You will be given a variable or function name and the surrounding code context.`
      },
      {
        role: "user",
        content: userContent
      }
    ]
  };
}

export function openaiBatchRename({
  apiKey,
  baseURL,
  model,
  contextWindowSize,
  resume = undefined,
  batchSize = 10,
  systemPrompt = undefined,
}: {
  apiKey: string;
  baseURL: string;
  model: string;
  contextWindowSize: number;
  resume?: string;
  batchSize?: number;
  systemPrompt?: string;
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

        // 封装一次LLM请求和解析的逻辑，便于重试
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

            // 流结束后处理完整内容
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
      0.7,
      filePath
    );
  };
}

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

        Please provide the new names in the response as a JSON object mapping original names to new names.
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
