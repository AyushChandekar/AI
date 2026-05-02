import express from "express";
import { run } from "./agent.js";

const app = express();
const PORT = process.env.PORT ?? 8000;

app.use(express.json());

app.post("/message", async (req, res) => {
  try {
    const message = req.body.message;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    const response = await run(message);

    return res.json({ message: response });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong" });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on ${PORT}`);
});