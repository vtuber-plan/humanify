import Anthropic from "@anthropic-ai/sdk";
import { visitAllIdentifiers } from "../local-llm-rename/visit-all-identifiers.js";
import { showPercentage } from "../../progress.js";
import { verbose } from "../../verbose.js";
import { createClientOptions } from "../../proxy-utils.js";

export function anthropicRename({
    apiKey,
    baseURL,
    model,
    contextWindowSize,
    resume = undefined,
    systemPrompt = undefined,
    uniqueNames = false,
}: {
    apiKey: string;
    baseURL?: string;
    model: string;
    contextWindowSize: number;
    resume?: string;
    systemPrompt?: string;
    uniqueNames?: boolean;
}) {
    const clientOptions = createClientOptions(baseURL || 'https://api.anthropic.com', {
        apiKey,
        baseURL
    });
    const client = new Anthropic(clientOptions);

    return async (code: string): Promise<string> => {
        return await visitAllIdentifiers(
            code,
            async (name, surroundingCode) => {
                verbose.log(`Renaming ${name}`);
                verbose.log("Context: ", surroundingCode);

                const response = await client.messages.create(
                    toRenamePrompt(name, surroundingCode, model, contextWindowSize, systemPrompt)
                );

                const result = response.content[0];
                if (!result) {
                    throw new Error('Failed to rename', { cause: response });
                }
                const renamed = result.input.newName
                verbose.log(`${name} renamed to ${renamed}`);
                return renamed;
            },
            contextWindowSize,
            showPercentage,
            resume,
            undefined, // filePath
            uniqueNames
        );
    };
}

function toRenamePrompt(
    name: string,
    surroundingCode: string,
    model: string,
    contextWindowSize: number,
    systemPrompt?: string,
): Anthropic.Messages.MessageCreateParams {
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
        content: `Analyze this code and suggest a descriptive name for the variable/function \`${name}\`:
        ${surroundingCode}`
    });
    
    return {
        model,
        messages,
        max_tokens: contextWindowSize,
        tools: [
            {
                name: "suggest_name",
                description: "Suggest a descriptive name for the code element",
                input_schema: {
                    type: "object",
                    properties: {
                        newName: {
                            type: "string",
                            description: `The new descriptive name for the variable/function called \`${name}\``
                        }
                    },
                    required: ["newName"],
                    additionalProperties: false
                }
            }
        ],
        tool_choice: {
            type: "tool",
            name: "suggest_name"
        }
    };
}