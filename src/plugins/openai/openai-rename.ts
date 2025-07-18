import OpenAI from "openai";
import { visitAllIdentifiers } from "../local-llm-rename/visit-all-identifiers.js";
import { showPercentage } from "../../progress.js";
import { verbose } from "../../verbose.js";
import { sleep } from "openai/core.mjs";

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
    return await visitAllIdentifiers(
      code,
      async (name, surroundingCode) => {
        verbose.log(`Renaming ${name}`);
        verbose.log("Context: ", surroundingCode);

        // 封装一次LLM请求和解析的逻辑，便于重试
        async function getRenamed(promptParams: { name: string; surroundingCode: string; model: string; extraPrompt?: string }, rawResult?: string): Promise<string> {
          if (rawResult) {
            return extractJsonResponse(rawResult);
          }

          // 检查模型名是否包含qwen3（不区分大小写），如果是则添加extra_body参数
          const isQwen3 = /qwen3/i.test(promptParams.model);
          const requestParams: any = {
            ...toRenamePrompt(promptParams.name, promptParams.surroundingCode, promptParams.model, promptParams.extraPrompt),
            stream: true,
          };
          if (isQwen3) {
            requestParams.extra_body = { chat_template_kwargs: { enable_thinking: false } };
          }

          const stream = await client.chat.completions.create(requestParams);

          let fullContent = "";
          const timeoutMs = 5 * 60 * 1000; // 5分钟超时
          const startTime = Date.now();

          try {
            for await (const chunk of stream) {
              if (Date.now() - startTime > timeoutMs) {
                throw new Error("Stream timeout after 30 seconds");
              }

              const content = chunk.choices[0]?.delta?.content || "";
              if (content) {
                fullContent += content;
                verbose.log("Stream chunk:", content);
              }
            }

            // 流结束后处理完整内容
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
          renamed = await getRenamed({ name, surroundingCode, model });
        } catch (error) {
          // 如果第一次解析失败，重新发给LLM让其只返回JSON
          verbose.log("Error parsing response:", error);
          verbose.log("Retrying with format correction prompt...");
          const formatPrompt = `请将下面的内容仅以JSON格式输出，且**不要包含任何多余的内容**，只返回JSON对象!!!`;
          try {
            renamed = await getRenamed({ name, surroundingCode, model, extraPrompt: formatPrompt });
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
  name: string,
  surroundingCode: string,
  model: string,
  extraPrompt?: string
): OpenAI.Chat.Completions.ChatCompletionCreateParams {
  let userContent = `Rename Javascript variables/function \`${name}\` to have descriptive name based on their usage in the code."
        Here is the surrounding code:
        \`\`\`javascript
        ${surroundingCode}
        \`\`\`

        Please provide the new name in the response as a JSON object with a single property "newName".
        The response should be a valid JSON string.
        For example:
        \`\`\`json
        {
          "newName": "descriptiveVariableName"
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
    ],
    // response_format: {
    //   type: "json_schema",
    //   json_schema: {
    //     strict: true,
    //     name: "rename",
    //     schema: {
    //       type: "object",
    //       properties: {
    //         newName: {
    //           type: "string",
    //           description: `The new name for the variable/function called \`${name}\``
    //         }
    //       },
    //       required: ["newName"],
    //       additionalProperties: false
    //     }
    //   }
    // }
  };
}
