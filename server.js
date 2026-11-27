import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

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
  const imageConfigured = Boolean(CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_API_TOKEN);

  res.json({
    success: true,
    server: "online",
    imageEngine: imageConfigured ? "configured" : "missing_credentials",
    imageModel: IMAGE_MODEL,
    skeletonEngine: "not_connected"
  });
});

app.post("/api/image", async (req, res, next) => {
  try {
    const { prompt } = req.body || {};

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({
        success: false,
        error: "Please provide an image prompt."
      });
    }

    if (prompt.trim().length > 2048) {
      return res.status(400).json({
        success: false,
        error: "Prompt must be 2048 characters or fewer."
      });
    }

    if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
      return res.status(503).json({
        success: false,
        error: "Image engine is not configured. Add Cloudflare credentials to the server environment."
      });
    }

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${IMAGE_MODEL}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt: prompt.trim(),
        steps: 4
      }),
      signal: AbortSignal.timeout(120000)
    });

    const data = await response.json();

    if (!response.ok || !data.success || !data.result?.image) {
      console.error("Cloudflare image generation failed:", {
        status: response.status,
        errors: data.errors
      });

      return res.status(502).json({
        success: false,
        error: "The image provider could not complete the request.",
        providerStatus: response.status
      });
    }

    return res.json({
      success: true,
      model: IMAGE_MODEL,
      image: `data:image/jpeg;base64,${data.result.image}`
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return res.status(504).json({
        success: false,
        error: "Image generation timed out. Please try again."
      });
    }
    next(error);
  }
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
