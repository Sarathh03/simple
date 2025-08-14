import express from "express";
import cors from "cors";
import { analyseCode } from "./analyseCode";

const app = express();
const PORT = 8080;

// Accept requests from any origin (other PC in same Wi-Fi)
app.use(cors());
app.use(express.json());

// Store last analysis result
let analysisResult: any = null;

// Array to track connected SSE clients
let clients: express.Response[] = [];

// POST endpoint to receive code from another PC
app.post("/receive-code", async (req, res) => {
  try {
    const { code, fileName, language } = req.body;

    if (!code || !fileName) {
      return res.status(400).json({ error: "Payload must include code and fileName" });
    }

    const lang = language || "python";
    console.log(`✅ Code received from ${fileName} (${lang}), running analysis...`);

    // Run analysis
    analysisResult = await analyseCode(code, lang);
    console.log("Analysis complete.");

    // Broadcast result to SSE clients
    broadcastResult(analysisResult);

    // Respond to sender
    res.status(200).json({ message: "Code analyzed successfully", analysisResult });
  } catch (err) {
    console.error("Analysis failed:", err);
    res.status(500).json({ error: "Analysis failed", details: err });
  }
});

// GET endpoint to fetch last analysis result
app.get("/result", (req, res) => {
  if (!analysisResult) {
    return res.status(404).json({ error: "No analysis result yet" });
  }
  res.json(analysisResult);
});

// SSE endpoint for frontend to receive real-time updates
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send current result immediately if available
  if (analysisResult) {
    res.write(`data: ${JSON.stringify(analysisResult)}\n\n`);
  }

  // Keep the client connection
  clients.push(res);

  req.on("close", () => {
    clients = clients.filter(c => c !== res);
  });
});

// Helper to broadcast result to all SSE clients
function broadcastResult(result: any) {
  clients.forEach(client => {
    client.write(`data: ${JSON.stringify(result)}\n\n`);
  });
}

// Replace <YOUR_LOCAL_IP> with your actual LAN IP
const LOCAL_IP = "192.168.161.13";

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on http://${LOCAL_IP}:${PORT}`);
});
