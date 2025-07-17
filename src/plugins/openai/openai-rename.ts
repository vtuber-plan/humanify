import OpenAI from "openai";
import { visitAllIdentifiers } from "../local-llm-rename/visit-all-identifiers.js";
import { showPercentage } from "../../progress.js";
import { verbose } from "../../verbose.js";
import { sleep } from "openai/core.mjs";

export function openaiRename({
  apiKey,
  baseURL,
  model,
  contextWindowSize
}: {
  apiKey: string;
  baseURL: string;
  model: string;
  contextWindowSize: number;
}) {
  const client = new OpenAI({ apiKey, baseURL });

  return async (code: string): Promise<string> => {
    const startTime = Date.now();
    return await visitAllIdentifiers(
      code,
      async (name, surroundingCode) => {
        verbose.log(`Renaming ${name}`);
        verbose.log("Context: ", surroundingCode);

        // 封装一次LLM请求和解析的逻辑，便于重试
        async function getRenamed(promptParams: { name: string; surroundingCode: string; model: string; extraPrompt?: string }, rawResult?: string): Promise<string> {
          let response, result, jsonStr;
          if (!rawResult) {
            response = await client.chat.completions.create(
              toRenamePrompt(promptParams.name, promptParams.surroundingCode, promptParams.model, promptParams.extraPrompt)
            );
            result = response.choices[0].message?.content;
            if (!result) {
              throw new Error("Failed to rename", { cause: response });
            }
            verbose.log("LLM return:", result);
          } else {
            result = rawResult;
          }

          jsonStr = result;
          if (result.includes('```')) {
            // 提取```json ...```或``` ...```中的内容，只取代码块内的内容
            const match = result.match(/```[a-z]*\s*([\s\S]*?)\s*```/i);
            if (match && match[1]) {
              jsonStr = match[1];
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
          verbose.log("Retrying with format correction prompt...");
          let errorMsg = "";
          let errorCauseMsg = "";
          if (error instanceof Error) {
            errorMsg = error.message || "";
            if (error.cause && typeof error.cause === "object" && error.cause !== null && "message" in error.cause) {
              errorCauseMsg = (error.cause as any).message || "";
            }
          }
          const formatPrompt = `请将下面的内容仅以JSON格式输出，且不要包含任何多余的内容，只返回JSON对象：\n${errorMsg}\n${errorCauseMsg}`;
          // 这里rawResult传result，prompt中说明只要JSON
          let rawResult;
          if (error instanceof Error && error.cause && typeof error.cause === "object" && error.cause !== null && "message" in error.cause) {
            rawResult = (error.cause as any).message;
          } else {
            rawResult = undefined;
          }
          try {
            renamed = await getRenamed({ name, surroundingCode, model, extraPrompt: formatPrompt }, rawResult);
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
      (percentage) => showPercentage(percentage, startTime)
    );
  };
}

function toRenamePrompt(
  name: string,
  surroundingCode: string,
  model: string,
  extraPrompt?: string
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
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
    response_format: {
      type: "json_schema",
      json_schema: {
        strict: true,
        name: "rename",
        schema: {
          type: "object",
          properties: {
            newName: {
              type: "string",
              description: `The new name for the variable/function called \`${name}\``
            }
          },
          required: ["newName"],
          additionalProperties: false
        }
      }
    }
  };
}
