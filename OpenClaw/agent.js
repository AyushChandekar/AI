import Groq from "groq-sdk";
import dotenv from "dotenv";
import { zodTextFormat } from "openai/helpers/zod";
import { execSync } from "node:child_process";

dotenv.config();

if (!process.env.GROQ_API_KEY) {
  throw new Error("Missing GROQ_API_KEY");
}

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const functionMapping = {
  executeCommand,
};

const SYSTEM_PROMPT = `You are an expert AI Assistant that is expert in controlling the user's machine. Analyze the user's query carefully and plan the steps on what needs to be done. Based on the user query you can create commands and then call the tool to run that command and execute on the user's machine

    Available Tools:
    - executeCommand(command: string): Output from the command 
    
    You can you the executeCommand tool to execute any command on user's machine
`;

const outputSchema = z.object({
  type: z.enum(["tool_call", "text"]).describe("what kind of response this is"),
  text_content: z
    .string()
    .optional()
    .nulable()
    .describe("text content if type is text"),
  tool_call: z
    .object({
      tool_name: z.string().describe("name of the tool"),
      params: z.array(z.string()),
    })
    .optional()
    .nullable()
    .describe("the params to call the tool if type is tool_call"),
});

function executeCommand(cmd = "") {
  try {
    const result = execSync(cmd, { encoding: "utf-8" });
    return result;
  } catch (err) {
    return err.message;
  }
}

const messages = [{ role: "system", content: SYSTEM_PROMPT }];
// main function
export async function run(query = "") {
    messages.push({role:'user',content:query,})
  while (true) {
    try {
      const response = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        text: {
          format: zodTextFormat(outputSchema, "output"),
        },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: query },
        ],
        temperature: 0.5,
        max_tokens: 1024,
      });

      const parsedOutput = result.output_parsed;
      switch (parsedOutput.type) {
        case "tool_call":
          {
            if (parsedOuput.tool_call) {
              const { params, tool_name } = parsedOutput.tool_call;
              console.log(`tool call: ${tool_name} :${params}`);
              if (functionMapping[tool_name]) {
                const toolOutput = functionMapping[tool_name](...params);
                console.log(`Tool Output (${tool_name}})`, toolOutput);
              }
            }
          }
          break;
        case "text":
          {
            return parsedOutput.text_content;
          }
          break;
      }

      const output = response.choices[0].message.content;

      console.log("Agent Says:", output);

      return output;
    } catch (error) {
      console.error("Error:", error);
      return "Something went wrong";
    }
  }
}

// test
// console.log(executeCommand("mkdir ayush"));

run("make a folder named test");
