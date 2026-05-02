import Groq from "groq-sdk";
import dotenv from "dotenv";
import { execSync } from "node:child_process";
import { z } from "zod";

dotenv.config();

if (!process.env.GROQ_API_KEY) {
  throw new Error("Missing GROQ_API_KEY");
}

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

function executeCommand(cmd = "") {
  try {
    const result = execSync(cmd, { encoding: "utf-8" });
    return result;
  } catch (err) {
    return err.message;
  }
}

const functionMapping = {
  executeCommand,
};

const SYSTEM_PROMPT = `You are an expert AI Assistant that is expert in controlling the user's machine. Analyze the user's query carefully and plan the steps on what needs to be done. Based on the user query you can create commands and then call the tool to run that command and execute on the user's machine

    Available Tools:
    - executeCommand(command: string): Output from the command 
    
    You can you the executeCommand tool to execute any command on user's machine
    IMPORTANT:
You MUST ONLY respond in valid JSON.

Do NOT return explanations, markdown, or text.

Valid formats:

For tool call:
{
  "type": "tool_call",
  "finalOutput": false,
  "tool_call": {
    "tool_name": "executeCommand",
    "params": ["mkdir test"]
  }
}

For final response:
{
  "type": "text",
  "finalOutput": true,
  "text_content": "Folder created successfully"
}
    `;

const outputSchema = z.object({
  type: z.enum(["tool_call", "text"]),
  finalOutput: z.boolean(),
  text_content: z.string().optional().nullable(),
  tool_call: z
    .object({
      tool_name: z.string(),
      params: z.array(z.string()),
    })
    .optional()
    .nullable(),
});

const messages = [{ role: "system", content: SYSTEM_PROMPT }];

export async function run(query = "") {
  messages.push({ role: "user", content: query });

  while (true) {
    try {
      const response = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: messages,
        temperature: 0.5,
        max_tokens: 1024,
      });

      const rawOutput = response.choices[0].message.content;

      let parsedOutput;
      try {
        parsedOutput = outputSchema.parse(JSON.parse(rawOutput));
      } catch (e) {
        console.log("Invalid JSON from model:", rawOutput);
        return rawOutput;
      }

      messages.push({
        role: "assistant",
        content: rawOutput,
      });

      switch (parsedOutput.type) {
        case "tool_call": {
          if (parsedOutput.tool_call) {
            const { params, tool_name } = parsedOutput.tool_call;

            console.log(`Tool Call → ${tool_name}:`, params);

            if (functionMapping[tool_name]) {
              const toolOutput = functionMapping[tool_name](...params);

              console.log(`Tool Output (${tool_name}):`, toolOutput);

              messages.push({
                role: "tool",
                name: tool_name,
                content: toolOutput,
              });

              continue;
            }
          }
          break;
        }

        case "text": {
          console.log("Text:", parsedOutput.text_content);
          if (parsedOutput.finalOutput) {
            return parsedOutput.text_content;
          }
          break;
        }
      }
    } catch (error) {
      console.error("Error:", error);
      return "Something went wrong";
    }
  }
}

// test
run("make a folder named iphone");