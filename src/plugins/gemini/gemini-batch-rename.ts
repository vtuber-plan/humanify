import { batchVisitAllIdentifiersGrouped } from "../local-llm-rename/batch-visit-all-indentifiers.js";
import { verbose } from "../../verbose.js";
import { showPercentage } from "../../progress.js";
import {
  GoogleGenerativeAI,
  ModelParams,
  SchemaType
} from "@google/generative-ai";

export function geminiBatchRename({
  apiKey,
  model: modelName,
  contextWindowSize,
  resume = undefined,
  batchSize = 10,
  batchConcurrency = 1,
  smallScopeMergeLimit = 2,
  systemPrompt = undefined,
  uniqueNames = false,
}: {
  apiKey: string;
  model: string;
  contextWindowSize: number;
  resume?: string;
  batchSize?: number;
  batchConcurrency?: number;
  smallScopeMergeLimit?: number;
  systemPrompt?: string;
  uniqueNames?: boolean;
}) {
  // Google Generative AI client doesn't support custom HTTP agents directly
  // We'll create it without proxy support for now
  const client = new GoogleGenerativeAI(apiKey);

  return async (code: string, filePath?: string): Promise<string> => {
    const startTime = Date.now();
    return await batchVisitAllIdentifiersGrouped(
      code,
      async (names, surroundingCode) => {
        verbose.log(`Batch renaming: ${names.join(", ")}`);
        verbose.log("Context: ", surroundingCode);

        const model = client.getGenerativeModel(
          toBatchRenameParams(names, modelName, systemPrompt)
        );

        const result = await model.generateContent(surroundingCode);
        const renameMap = JSON.parse(result.response.text());

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

function toBatchRenameParams(names: string[], model: string, systemPrompt?: string): ModelParams {
  const properties: Record<string, any> = {};
  names.forEach(name => {
    properties[name] = {
      type: SchemaType.STRING,
      nullable: false,
      description: `The new descriptive name for the variable/function called \`${name}\``
    };
  });

  const defaultSystemPrompt = `Rename the following Javascript variables/functions: \`${names.join(", ")}\` to have descriptive names based on their usage in the code.`;
  const finalSystemPrompt = systemPrompt ? `${systemPrompt}\n\n${defaultSystemPrompt}` : defaultSystemPrompt;
  
  return {
    model,
    systemInstruction: finalSystemPrompt,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        nullable: false,
        description: "The new names for the variables/functions",
        type: SchemaType.OBJECT,
        properties,
        required: names
      }
    }
  };
} 
