import Groq from "groq-sdk";
import dotenv from "dotenv";
import { execSync } from "node:child_process";
import { z } from "zod";
import crypto from "crypto";
import path from "path";  // FIX 5: use path module for reliable cd handling
import fs from "fs";

dotenv.config();

if (!process.env.GROQ_API_KEY) {
  throw new Error("Missing GROQ_API_KEY");
}

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

let currentDir = process.cwd();

function executeCommand(cmd = "") {
  try {
    // FIX 5: robust cd — uses path.resolve so "cd .." and nested paths work correctly
    if (cmd.trim().startsWith("cd")) {
      const parts = cmd.trim().split(/\s+/);
      const folder = parts[1];
      if (!folder) return `Current directory: ${currentDir}`;
      currentDir = path.resolve(currentDir, folder);
      return `Changed directory to ${currentDir}`;
    }

    const result = execSync(cmd, {
      encoding: "utf-8",
      cwd: currentDir,
    });

    return result || "Command executed successfully";
  } catch (err) {
    return err.message;
  }
}

// FIX 4: writeFile now writes relative to currentDir, not the process cwd
function writeFile(filename, content) {
  const fullPath = path.resolve(currentDir, filename);
  fs.writeFileSync(fullPath, content);
  return `File written successfully: ${fullPath}`;
}

const functionMapping = {
  executeCommand,
  writeFile,
};

const SYSTEM_PROMPT = `You are an expert AI Assistant that is expert in controlling the user's machine. Analyze the user's query carefully and plan the steps on what needs to be done. Based on the user query you can create commands and then call the tool to run that command and execute on the user's machine

    Available Tools:
    - executeCommand(command: string): Output from the command 
    
    You can you the executeCommand tool to execute any command on user's machine
    IMPORTANT:
You MUST ONLY respond in valid JSON.

Do NOT return explanations, markdown, or text.

Valid formats examples:

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
remember you are using windows 
You MUST break tasks into multiple steps.

Example for creating a project:
1. Create folder
2. Move into folder
3. Create files
4. Write content

After each tool execution, continue calling tools until task is complete.

Only return:
{
  "type": "text",
  "finalOutput": true,
  "text_content": "Task completed"
}
when ALL steps are done. `;

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

export async function run(query = "") {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  messages.push({ role: "user", content: query });
  let steps = 0;
  const MAX_STEPS = 20; // bumped up — a "create todo app" task needs ~10–15 steps

  while (steps < MAX_STEPS) {
    steps++; // FIX 2: increment at the TOP of the loop, not at the bottom after a return

    try {
      const response = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: messages,
        temperature: 0.5,
        max_tokens: 4096, // raised — file contents need more tokens
      });

      const rawOutput = response.choices[0].message.content;

      let parsedOutput;
      try {
        const cleanedOutput = rawOutput
          .replace(/```json/g, "")
          .replace(/```/g, "")
          .trim();

        parsedOutput = outputSchema.parse(JSON.parse(cleanedOutput));
      } catch (e) {
        console.log("Invalid JSON from model:", rawOutput);
        return rawOutput;
      }

      switch (parsedOutput.type) {
        case "tool_call": {
          if (parsedOutput.tool_call) {
            const { params, tool_name } = parsedOutput.tool_call;
            const toolCallId = crypto.randomUUID();
            console.log(`Tool Call → ${tool_name}:`, params);

            messages.push({
              role: "assistant",
              content: rawOutput,
              tool_calls: [
                {
                  id: toolCallId,
                  type: "function",
                  function: {
                    name: tool_name,
                    arguments: JSON.stringify({ params }),
                  },
                },
              ],
            });

            if (functionMapping[tool_name]) {
              const toolOutput = functionMapping[tool_name](...params);
              console.log(`Tool Output (${tool_name}):`, toolOutput);

              const isError =
                toolOutput.toLowerCase().includes("cannot find") ||
                toolOutput.toLowerCase().includes("not recognized") ||
                toolOutput.toLowerCase().includes("failed");

              // FIX 3: push the tool result ONCE only (was pushed twice before)
              messages.push({
                role: "tool",
                tool_call_id: toolCallId,
                content: toolOutput,
              });

              if (toolOutput.toLowerCase().includes("cannot find")) {
                return "Folder does not exist.";
              }

              if (isError) {
                return `Operation failed: ${toolOutput}`;
              }

              messages.push({
                role: "system",
                content:
                  "Continue the task. If all steps are complete, return finalOutput=true.",
              });

              continue; // go back to top of while loop
            }
          }
          break;
        }

        case "text": {
          if (parsedOutput.finalOutput) {
            console.log("Final output:", parsedOutput.text_content);
            return parsedOutput.text_content;
          }
          // model returned text but finalOutput=false — keep looping
          messages.push({ role: "assistant", content: rawOutput });
          messages.push({
            role: "system",
            content: "Continue the task. If all steps are complete, return finalOutput=true.",
          });
          continue;
        }
      }
    } catch (error) {
      console.error("Error:", error);
      return "Something went wrong";
    }
  }

  // FIX 1: "Stopped" is now OUTSIDE the while loop — only triggers when MAX_STEPS is hit
  return `Stopped: reached maximum steps (${MAX_STEPS})`;
}