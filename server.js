
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => {
  res.json({
    name: "VORTEX AI",
    status: "online",
    message: "VORTEX AI Engine is running"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    server: "online",
    imageEngine: "not_connected",
    skeletonEngine: "not_connected"
  });
});

app.post("/api/image", (req, res) => {
  const { prompt } = req.body || {};

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({
      success: false,
      error: "Please provide an image prompt."
    });
  }

  return res.status(501).json({
    success: false,
    error: "Image generation model is not connected yet."
  });
});

app.post("/api/skeleton", (req, res) => {
  const { prompt } = req.body || {};

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({
      success: false,
      error: "Please provide a motion prompt."
    });
  }

  return res.status(501).json({
    success: false,
    error: "Skeleton motion model is not connected yet."
  });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "API endpoint not found."
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    success: false,
    error: "Internal server error."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`VORTEX AI server running on port ${PORT}`);
});
