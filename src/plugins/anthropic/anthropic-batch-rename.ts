import Anthropic from "@anthropic-ai/sdk";
import { batchVisitAllIdentifiersGrouped } from "../local-llm-rename/batch-visit-all-indentifiers.js";
import { showPercentage } from "../../progress.js";
import { verbose } from "../../verbose.js";
import { createClientOptions } from "../../proxy-utils.js";

export function anthropicBatchRename({
    apiKey,
    baseURL,
    model,
    contextWindowSize,
    resume = undefined,
    batchSize = 10,
    systemPrompt = undefined,
}: {
    apiKey: string;
    baseURL?: string;
    model: string;
    contextWindowSize: number;
    resume?: string;
    batchSize?: number;
    systemPrompt?: string;
}) {
    const clientOptions = createClientOptions(baseURL || 'https://api.anthropic.com', {
        apiKey,
        baseURL
    });
    const client = new Anthropic(clientOptions);

    return async (code: string): Promise<string> => {
        const startTime = Date.now();
        return await batchVisitAllIdentifiersGrouped(
            code,
            async (names, surroundingCode) => {
                verbose.log(`Batch renaming: ${names.join(", ")}`);
                verbose.log("Context: ", surroundingCode);

                const response = await client.messages.create(
                    toBatchRenamePrompt(names, surroundingCode, model, contextWindowSize, systemPrompt)
                ) as Anthropic.Messages.Message;

                const result = response.content[0];
                if (!result) {
                    throw new Error('Failed to rename', { cause: response });
                }
                
                const renameMap = (result as any).input;
                verbose.log(`Batch renamed:`, renameMap);
                return renameMap;
            },
            contextWindowSize,
            (percentage) => showPercentage(percentage, startTime),
            resume,
            batchSize
        );
    };
}

function toBatchRenamePrompt(
    names: string[],
    surroundingCode: string,
    model: string,
    contextWindowSize: number,
    systemPrompt?: string,
): Anthropic.Messages.MessageCreateParams {
    const properties: Record<string, any> = {};
    names.forEach(name => {
        properties[name] = {
            type: "string",
            description: `The new descriptive name for the variable/function called \`${name}\``
        };
    });

    const defaultSystemPrompt = `You are a helpful assistant that renames Javascript variables and functions to have more descriptive names based on their usage in the code.`;
    const finalSystemPrompt = systemPrompt ? `${systemPrompt}\n\n${defaultSystemPrompt}` : defaultSystemPrompt;
    
    const messages = [];
    if (systemPrompt) {
        messages.push({
            role: "user" as const,
            content: finalSystemPrompt
        });
    }
    messages.push({
        role: "user" as const,
        content: `Analyze this code and suggest descriptive names for the variables/functions: \`${names.join(", ")}\`:
        ${surroundingCode}`
    });
    
    return {
        model,
        messages,
        max_tokens: contextWindowSize,
        tools: [
            {
                name: "suggest_names",
                description: "Suggest descriptive names for the code elements",
                input_schema: {
                    type: "object",
                    properties,
                    required: names,
                    additionalProperties: false
                }
            }
        ],
        tool_choice: {
            type: "tool",
            name: "suggest_names"
        }
    };
} 