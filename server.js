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

app.use((req, res, next) => {
  const startedAt = Date.now();
  console.log(`[http] ${req.method} ${req.path} received`);
  res.on("finish", () => {
    console.log(`[http] ${req.method} ${req.path} -> ${res.statusCode} in ${Date.now() - startedAt}ms`);
  });
  next();
});

app.get("/", (req, res) => {
  res.json({
    name: "VORTEX AI",
    status: "online",
    message: "VORTEX AI Engine is running"
  });
});

app.get("/api/health", (req, res) => {
  const imageConfigured = Boolean(CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_API_TOKEN);

  const videoConfigured = Boolean(process.env.VORTEX_AGNES_API_KEY);
  res.json({
    success: true,
    server: "online",
    imageEngine: imageConfigured ? "configured" : "missing_credentials",
    imageModel: IMAGE_MODEL,
    skeletonEngine: "not_connected",
    videoEngine: videoConfigured ? "connected" : "free_provider_setup_required",
    videoModel: "agnes-video-2.5-flash"
  });
});

app.post("/api/image", async (req, res, next) => {
  const requestId = Math.random().toString(36).slice(2, 8);
  const startedAt = Date.now();

  try {
    console.log(`[image:${requestId}] Request received`);
    const { prompt } = req.body || {};

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      console.log(`[image:${requestId}] Rejected: missing prompt`);
      return res.status(400).json({
        success: false,
        error: "Please provide an image prompt."
      });
    }

    if (prompt.trim().length > 2048) {
      console.log(`[image:${requestId}] Rejected: prompt too long`);
      return res.status(400).json({
        success: false,
        error: "Prompt must be 2048 characters or fewer."
      });
    }

    if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
      console.error(`[image:${requestId}] Missing Cloudflare credentials`);
      return res.status(503).json({
        success: false,
        error: "Image engine is not configured."
      });
    }

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${IMAGE_MODEL}`;
    console.log(`[image:${requestId}] Sending request to Cloudflare model ${IMAGE_MODEL}`);

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
      signal: AbortSignal.timeout(90000)
    });

    console.log(`[image:${requestId}] Cloudflare responded: HTTP ${response.status}; content-type: ${response.headers.get("content-type") || "unknown"}`);

    const rawBody = await response.text();
    let data;

    try {
      data = JSON.parse(rawBody);
    } catch {
      console.error(`[image:${requestId}] Cloudflare returned non-JSON data; body length: ${rawBody.length}`);
      return res.status(502).json({
        success: false,
        error: "The image provider returned an unexpected response.",
        providerStatus: response.status
      });
    }

    if (!response.ok || !data.success || !data.result?.image) {
      console.error(`[image:${requestId}] Cloudflare image generation failed:`, {
        status: response.status,
        errors: data.errors
      });

      return res.status(502).json({
        success: false,
        error: "The image provider could not complete the request.",
        providerStatus: response.status,
        providerErrors: data.errors
      });
    }

    console.log(`[image:${requestId}] Image generated successfully in ${Date.now() - startedAt}ms; base64 length: ${data.result.image.length}`);

    return res.json({
      success: true,
      model: IMAGE_MODEL,
      image: `data:image/jpeg;base64,${data.result.image}`
    });
  } catch (error) {
    console.error(`[image:${requestId}] Request failed after ${Date.now() - startedAt}ms:`, error.name, error.message);

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


let videoBusy = false;

app.get("/api/video/status", (req, res) => {
  const configured = Boolean(process.env.VORTEX_AGNES_API_KEY);
  res.json({
    success: true,
    engine: configured ? "connected" : "free_provider_setup_required",
    model: "agnes-video-2.5-flash",
    configured,
    maxSeconds: 12,
    resolution: "720p",
    pricing: "promotional-free-subject-to-provider-policy"
  });
});

app.post("/api/video", async (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  const duration = Number(req.body?.duration ?? 5);
  const aspectRatio = req.body?.aspect_ratio;
  const image = req.body?.image;
  const apiKey = process.env.VORTEX_AGNES_API_KEY;

  if (!prompt || prompt.length > 3000) {
    return res.status(400).json({ success: false, error: "Prompt must contain 1 to 3000 characters." });
  }
  if (!Number.isInteger(duration) || duration < 4 || duration > 12) {
    return res.status(400).json({ success: false, error: "Video duration must be between 4 and 12 seconds." });
  }
  if (!["9:16", "16:9", "1:1", "4:3", "3:4", "21:9"].includes(aspectRatio)) {
    return res.status(400).json({ success: false, error: "Unsupported aspect ratio." });
  }
  if (!apiKey) {
    return res.status(503).json({
      success: false,
      error: "کلید اتصال Agnes روی همین سرویس Render تنظیم نشده است؛ هیچ درخواست ویدیویی ارسال نشد."
    });
  }
  if (image !== undefined && image !== null) {
    const validDataImage = typeof image === "string" && /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(image);
    const validHttpsUrl = typeof image === "string" && /^https:\/\/[^\s]+$/i.test(image);
    if (!validDataImage && !validHttpsUrl) {
      return res.status(400).json({ success: false, error: "Reference image must be a JPEG, PNG, or WebP data URI or HTTPS URL." });
    }
    if (validDataImage && image.length > 8 * 1024 * 1024) {
      return res.status(413).json({ success: false, error: "Reference image is too large. Maximum file size is 6 MB." });
    }
  }
  if (videoBusy) {
    return res.status(429).json({ success: false, error: "The video engine is busy. Please try again shortly." });
  }

  videoBusy = true;
  try {
    const payload = {
      model: "agnes-video-2.5-flash",
      prompt,
      mode: image ? "img2video" : "text",
      seconds: String(duration),
      size: "720P",
      aspect_ratio: aspectRatio,
      n: 1
    };
    if (image) payload.first_frame = image;

    const createResponse = await fetch("https://apihub.agnes-ai.com/v1/videos", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000)
    });
    const created = await createResponse.json().catch(() => null);
    if (!createResponse.ok) {
      console.error("Agnes video create failed:", createResponse.status, created?.error || created?.message || "");
      return res.status(createResponse.status === 429 ? 429 : 502).json({
        success: false,
        error: createResponse.status === 429
          ? "صف درخواست‌های رایگان شلوغ است یا محدودیت درخواست فعال شده؛ کمی بعد دوباره امتحان کن."
          : "Agnes could not accept the video request.",
        details: created?.error?.message || created?.message || created?.error || undefined
      });
    }

    const videoId = created?.video_id || created?.id || created?.task_id;
    if (!videoId) {
      console.error("Agnes response missing video id:", JSON.stringify(created || {}).slice(0, 1500));
      return res.status(502).json({ success: false, error: "Agnes did not return a video task ID." });
    }

    const pollUrl = new URL("https://apihub.agnes-ai.com/agnesapi");
    pollUrl.searchParams.set("video_id", videoId);
    pollUrl.searchParams.set("model_name", "agnes-video-2.5-flash");

    let result = null;
    const deadline = Date.now() + 210000;
    let waitMs = 5000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
      const pollResponse = await fetch(pollUrl, {
        headers: { Authorization: "Bearer " + apiKey },
        signal: AbortSignal.timeout(30000)
      });
      result = await pollResponse.json().catch(() => null);
      if (!pollResponse.ok) {
        if ([408, 429, 500, 502, 503, 504, 520, 522, 524].includes(pollResponse.status)) {
          waitMs = Math.min(waitMs * 1.5, 15000);
          continue;
        }
        return res.status(502).json({ success: false, error: "Could not check Agnes video status." });
      }
      const status = String(result?.status || "").toLowerCase();
      if (["completed", "succeeded", "success", "done"].includes(status)) break;
      if (["failed", "error", "cancelled"].includes(status)) {
        return res.status(502).json({
          success: false,
          error: "Agnes video generation failed.",
          details: result?.error || undefined
        });
      }
      waitMs = Math.min(waitMs * 1.25, 12000);
    }

    const videoUrl = result?.url || result?.metadata?.url || result?.video_url;
    if (!videoUrl || typeof videoUrl !== "string" || !videoUrl.startsWith("https://")) {
      return res.status(504).json({
        success: false,
        error: "ویدیوسازی هنوز در صف است و زمان انتظار سرور تمام شد. کمی بعد دوباره تلاش کن."
      });
    }

    return res.json({
      success: true,
      model: "agnes-video-2.5-flash",
      video: videoUrl,
      video_id: videoId,
      duration,
      resolution: "720p",
      pricing: "promotional-free-subject-to-provider-policy"
    });
  } catch (error) {
    console.error("VORTEX Agnes video error:", error.message);
    const timeout = error.name === "TimeoutError" || error.name === "AbortError";
    return res.status(timeout ? 504 : 502).json({
      success: false,
      error: timeout ? "Video generation timed out while waiting for Agnes." : "Could not reach the Agnes video service."
    });
  } finally {
    videoBusy = false;
  }
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
