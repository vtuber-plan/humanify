import { visitAllIdentifiers } from "../local-llm-rename/visit-all-identifiers.js";
import { verbose } from "../../verbose.js";
import { showPercentage } from "../../progress.js";
import {
  GoogleGenerativeAI,
  ModelParams,
  SchemaType
} from "@google/generative-ai";

export function geminiRename({
  apiKey,
  model: modelName,
  contextWindowSize,
  resume = undefined,
  systemPrompt = undefined,
  uniqueNames = false,
}: {
  apiKey: string;
  model: string;
  contextWindowSize: number;
  resume?: string;
  systemPrompt?: string;
  uniqueNames?: boolean;
}) {
  // Google Generative AI client doesn't support custom HTTP agents directly
  // We'll create it without proxy support for now
  const client = new GoogleGenerativeAI(apiKey);

  return async (code: string, filePath?: string): Promise<string> => {
    const startTime = Date.now();
    return await visitAllIdentifiers(
      code,
      async (name, surroundingCode) => {
        verbose.log(`Renaming ${name}`);
        verbose.log("Context: ", surroundingCode);

        const model = client.getGenerativeModel(
          toRenameParams(name, modelName, systemPrompt)
        );

        const result = await model.generateContent(surroundingCode);

        const renamed = JSON.parse(result.response.text()).newName;

        verbose.log(`Renamed to ${renamed}`);

        return renamed;
      },
      contextWindowSize,
      (percentage) => showPercentage(percentage, startTime),
      resume,
      filePath,
      uniqueNames
    );
  };
}

function toRenameParams(name: string, model: string, systemPrompt?: string): ModelParams {
  const defaultSystemPrompt = `Rename Javascript variables/function \`${name}\` to have descriptive name based on their usage in the code.`;
  const finalSystemPrompt = systemPrompt ? `${systemPrompt}\n\n${defaultSystemPrompt}` : defaultSystemPrompt;
  
  return {
    model,
    systemInstruction: finalSystemPrompt,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        nullable: false,
        description: "The new name for the variable/function",
        type: SchemaType.OBJECT,
        properties: {
          newName: {
            type: SchemaType.STRING,
            nullable: false,
            description: `The new name for the variable/function called \`${name}\``
          }
        },
        required: ["newName"]
      }
    }
  };
}
