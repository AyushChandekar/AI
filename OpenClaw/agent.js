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

const SYSTEM_PROMPT = `You are an expert AI Assistant that controls the user's Windows machine. Analyze the query carefully, plan every step, execute commands one at a time, and verify results before declaring success.

Available Tools:
- executeCommand(command: string): Runs a shell command and returns its output.
- writeFile(filename: string, content: string): Writes content to a file. Use this for creating/editing files.

CRITICAL RULES:
1. You MUST ONLY respond in valid JSON — no explanations, markdown, or plain text ever.
2. You MUST break every task into small steps and execute each one with a tool call.
3. You MUST verify the result after every state-changing operation by running a follow-up command.
4. NEVER return finalOutput=true unless you have confirmed the task succeeded via a verification command.
5. For "kill / stop / remove" operations: first query what is running, then stop it, then verify it is gone.
6. For Docker: always run "docker ps" first to get the container ID, then stop/rm it, then run "docker ps" again to confirm it is no longer listed.

Response format — tool call:
{
  "type": "tool_call",
  "finalOutput": false,
  "tool_call": {
    "tool_name": "executeCommand",
    "params": ["docker ps"]
  }
}

Response format — write file:
{
  "type": "tool_call",
  "finalOutput": false,
  "tool_call": {
    "tool_name": "writeFile",
    "params": ["index.html", "<html>...</html>"]
  }
}

Response format — final answer (ONLY after verification confirms success):
{
  "type": "text",
  "finalOutput": true,
  "text_content": "Nginx container stopped and removed successfully."
}

Example — stopping a Docker container:
Step 1: executeCommand("docker ps") → find the container ID
Step 2: executeCommand("docker stop <id>") → stop it
Step 3: executeCommand("docker rm <id>") → remove it
Step 4: executeCommand("docker ps") → confirm it is no longer listed
Step 5: return finalOutput=true only after confirming it is gone

Example — creating a project:
Step 1: executeCommand("mkdir myapp")
Step 2: executeCommand("cd myapp")
Step 3: writeFile("index.js", "console.log('hello')")
Step 4: return finalOutput=true

You are on Windows. Use Windows-compatible commands (e.g. "dir" not "ls", "type" not "cat") unless running inside Docker or WSL.`;

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
        model: "llama-3.1-8b-instant",
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

              messages.push({
                role: "tool",
                tool_call_id: toolCallId,
                content: toolOutput,
              });

              // Only hard-abort on "not recognized" — a truly unrecoverable shell error.
              // Let the model handle all other error strings (docker errors, missing files, etc.)
              // so it can retry, adjust, or report them in its final answer.
              if (toolOutput.toLowerCase().includes("is not recognized as an internal or external command")) {
                return `Command not found: ${toolOutput}`;
              }

              messages.push({
                role: "system",
                content:
                  "Continue the task. Verify your last action succeeded before moving on. If all steps are complete and verified, return finalOutput=true.",
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