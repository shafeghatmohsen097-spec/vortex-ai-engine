import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

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

// Experimental local text-to-motion engine (runs on this Render service; no external inference API).
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const execFileAsync = promisify(execFile);

const MOTION_ROOT = path.join(os.tmpdir(), "vortex-sprongmotion");
const MOTION_MODEL = path.join(MOTION_ROOT, "SprongMotion-14M-v1.0-Q8_0.gguf");
const MOTION_BIN = path.join(MOTION_ROOT, "sprongmotion-generate");
const MOTION_SHA256 = "68fbd311a0d7d75f60508b35254171583c85880e7e124140457b57ac84c5de9d";
let motionInitPromise = null;
let motionBusy = false;

const MOTION_HELPER_SOURCE = String.raw`
#include <stdio.h>
#include <stdlib.h>
#include "sprongmotion.h"

int main(int argc, char **argv) {
    if (argc != 4) {
        fprintf(stderr, "usage: sprongmotion-generate model.gguf prompt seconds\n");
        return 2;
    }

    char *end = NULL;
    float seconds = strtof(argv[3], &end);
    if (end == argv[3] || *end != '\0' || seconds < 0.5f || seconds > 3.0f) {
        fprintf(stderr, "seconds must be between 0.5 and 3.0\n");
        return 2;
    }

    sm_set_thread_count(1);
    sm_model model = sm_load_model(argv[1]);
    if (!sm_is_model_valid(model)) {
        fprintf(stderr, "%s\n", sm_get_error());
        return 1;
    }

    sm_options options = sm_default_options(model);
    options.seconds = seconds;
    options.steps = 4;
    options.residual_layers = 1;
    options.foot_lock = true;

    sm_motion motion = sm_generate_motion_ex(model, argv[2], options);
    if (!sm_is_motion_valid(motion)) {
        fprintf(stderr, "%s\n", sm_get_error());
        sm_unload_model(model);
        return 1;
    }

    char *bvh = sm_export_motion_bvh_text(motion, 100.0f);
    if (!bvh) {
        fprintf(stderr, "%s\n", sm_get_error());
        sm_unload_motion(motion);
        sm_unload_model(model);
        return 1;
    }

    fputs(bvh, stdout);
    sm_free(bvh);
    sm_unload_motion(motion);
    sm_unload_model(model);
    return 0;
}
`;

async function downloadMotionFile(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) {
    throw new Error("Download failed with HTTP " + response.status);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
}

async function ensureMotionRuntime() {
  if (motionInitPromise) return motionInitPromise;
  motionInitPromise = (async () => {
    await fsp.mkdir(MOTION_ROOT, { recursive: true });
    const sourceDir = path.join(MOTION_ROOT, "sprongmotion-runtime-main");
    const helperPath = path.join(MOTION_ROOT, "generate.c");

    if (!fs.existsSync(MOTION_BIN)) {
      const archive = path.join(MOTION_ROOT, "runtime.tar.gz");
      if (!fs.existsSync(path.join(sourceDir, "Makefile"))) {
        await downloadMotionFile(
          "https://codeload.github.com/SegerEnd/sprongmotion-runtime/tar.gz/refs/heads/main",
          archive
        );
        await execFileAsync("tar", ["-xzf", archive, "-C", MOTION_ROOT], { timeout: 60000 });
        await fsp.rm(archive, { force: true });
      }

      await execFileAsync("make", ["lib"], { cwd: sourceDir, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
      await fsp.writeFile(helperPath, MOTION_HELPER_SOURCE, "utf8");
      await execFileAsync("cc", [
        "-std=c11", "-O2", "-I", path.join(sourceDir, "include"),
        helperPath, path.join(sourceDir, "build", "libsprongmotion.a"),
        "-lm", "-pthread", "-o", MOTION_BIN
      ], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    }

    if (!fs.existsSync(MOTION_MODEL)) {
      const partial = MOTION_MODEL + ".part";
      await downloadMotionFile(
        "https://huggingface.co/SegerEnd/SprongMotion-14M/resolve/main/SprongMotion-14M-v1.0-Q8_0.gguf?download=true",
        partial
      );
      const digest = crypto.createHash("sha256").update(await fsp.readFile(partial)).digest("hex");
      if (digest !== MOTION_SHA256) {
        await fsp.rm(partial, { force: true });
        throw new Error("SprongMotion model checksum mismatch");
      }
      await fsp.rename(partial, MOTION_MODEL);
    }

    return true;
  })().catch(error => {
    motionInitPromise = null;
    throw error;
  });
  return motionInitPromise;
}

// Build a short skeletal animation from an English action prompt.
// The model and C runtime execute on this Render instance, not on a remote inference provider.
app.post("/api/motion", async (req, res) => {
  const prompt = req.body?.prompt;
  const seconds = Number(req.body?.seconds ?? 1.5);
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 240) {
    return res.status(400).json({ success: false, error: "Prompt must contain 1 to 240 characters." });
  }
  if (!Number.isFinite(seconds) || seconds < 0.5 || seconds > 3) {
    return res.status(400).json({ success: false, error: "Duration must be between 0.5 and 3 seconds." });
  }
  if (motionBusy) {
    return res.status(429).json({ success: false, error: "The local motion engine is busy. Try again shortly." });
  }

  motionBusy = true;
  try {
    await ensureMotionRuntime();
    const { stdout } = await execFileAsync(
      MOTION_BIN,
      [MOTION_MODEL, prompt.trim(), String(seconds)],
      { timeout: 120000, maxBuffer: 12 * 1024 * 1024 }
    );
    if (!stdout || !stdout.startsWith("HIERARCHY")) {
      return res.status(502).json({ success: false, error: "The motion model returned an invalid BVH file." });
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", 'attachment; filename="vortex-motion.bvh"');
    res.setHeader("X-Vortex-Model", "SprongMotion-14M");
    return res.send(stdout);
  } catch (error) {
    console.error("VORTEX local motion engine error:", error.message);
    return res.status(503).json({
      success: false,
      error: "The local motion engine could not start or finish on this server.",
      details: error.message
    });
  } finally {
    motionBusy = false;
  }
});

app.get("/api/motion/status", (req, res) => {
  res.json({
    success: true,
    engine: "SprongMotion-14M",
    execution: "local-render-server",
    ready: fs.existsSync(MOTION_BIN) && fs.existsSync(MOTION_MODEL),
    output: "BVH skeletal animation",
    maxSeconds: 3
  });
});



// Local BVH-to-MP4 preview renderer: draws the generated skeleton as a 2D stick figure.
function parseMotionBvh(source) {
  const t = source.match(/[{}]|[^\s{}]+/g) || [];
  let i = 0;
  const take = () => t[i++];
  const expect = value => { const got=take(); if(got!==value) throw new Error("Invalid BVH near "+got+"; expected "+value); };
  const number = () => { const n=Number(take()); if(!Number.isFinite(n)) throw new Error("Invalid BVH number"); return n; };
  function joint(kind,name) {
    const node={kind,name,offset:[0,0,0],channels:[],children:[]}; expect("{");
    while(i<t.length&&t[i]!=="}") {
      const key=take();
      if(key==="OFFSET") node.offset=[number(),number(),number()];
      else if(key==="CHANNELS") { const count=number(); for(let k=0;k<count;k++) node.channels.push(take()); }
      else if(key==="JOINT") node.children.push(joint("JOINT",take()));
      else if(key==="End") { expect("Site"); node.children.push(joint("End",node.name+"_End")); }
      else throw new Error("Unsupported BVH token: "+key);
    }
    expect("}"); return node;
  }
  expect("HIERARCHY"); expect("ROOT"); const root=joint("ROOT",take());
  expect("MOTION"); expect("Frames:"); const frameCount=number(); expect("Frame"); expect("Time:"); const frameTime=number();
  const flat=[]; while(i<t.length){const n=Number(take());if(!Number.isFinite(n))throw new Error("Invalid BVH motion data");flat.push(n);}
  const count=n=>n.channels.length+n.children.reduce((s,c)=>s+count(c),0);
  const channelCount=count(root);
  if(!frameCount||flat.length<frameCount*channelCount)throw new Error("BVH frame data is incomplete");
  return {root,frameCount,frameTime,flat,channelCount};
}
function motionMatMul(a,b) {
  const o=new Array(9).fill(0);
  for(let r=0;r<3;r++)for(let c=0;c<3;c++)for(let k=0;k<3;k++)o[r*3+c]+=a[r*3+k]*b[k*3+c];
  return o;
}
function motionAxisRotation(axis,degrees) {
  const a=degrees*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
  if(axis==="X")return [1,0,0,0,c,-s,0,s,c];
  if(axis==="Y")return [c,0,s,0,1,0,-s,0,c];
  return [c,-s,0,s,c,0,0,0,1];
}
function motionFramePoints(root,values) {
  let cursor=0;const points=[];
  function visit(node,parentPos,parentBasis,parentName) {
    const o=node.offset;
    let pos=[parentPos[0]+parentBasis[0]*o[0]+parentBasis[1]*o[1]+parentBasis[2]*o[2],parentPos[1]+parentBasis[3]*o[0]+parentBasis[4]*o[1]+parentBasis[5]*o[2],parentPos[2]+parentBasis[6]*o[0]+parentBasis[7]*o[1]+parentBasis[8]*o[2]];
    let basis=parentBasis,trans=[0,0,0];
    for(const ch of node.channels){const v=values[cursor++];if(ch.endsWith("position"))trans["XYZ".indexOf(ch[0])]=v;else if(ch.endsWith("rotation"))basis=motionMatMul(basis,motionAxisRotation(ch[0],v));}
    pos=[pos[0]+parentBasis[0]*trans[0]+parentBasis[1]*trans[1]+parentBasis[2]*trans[2],pos[1]+parentBasis[3]*trans[0]+parentBasis[4]*trans[1]+parentBasis[5]*trans[2],pos[2]+parentBasis[6]*trans[0]+parentBasis[7]*trans[1]+parentBasis[8]*trans[2]];
    points.push({name:node.name,p:pos,parent:parentName});
    for(const child of node.children)visit(child,pos,basis,node.name);
  }
  visit(root,[0,0,0],[1,0,0,0,1,0,0,0,1],null);return points;
}
function motionLine(buf,w,h,x0,y0,x1,y1) {
  x0=Math.round(x0);y0=Math.round(y0);x1=Math.round(x1);y1=Math.round(y1);
  const dx=Math.abs(x1-x0),sx=x0<x1?1:-1,dy=-Math.abs(y1-y0),sy=y0<y1?1:-1;let err=dx+dy;
  while(true){if(x0>=0&&x0<w&&y0>=0&&y0<h){const p=(y0*w+x0)*3;buf[p]=105;buf[p+1]=190;buf[p+2]=255;}if(x0===x1&&y0===y1)break;const e=2*err;if(e>=dy){err+=dy;x0+=sx;}if(e<=dx){err+=dx;y0+=sy;}}
}
function motionRaster(points,bounds,w,h) {
  const buf=Buffer.alloc(w*h*3,13),span=Math.max(bounds.maxX-bounds.minX,bounds.maxY-bounds.minY,1),scale=Math.min(w,h)*0.78/span;
  const ox=w/2-(bounds.minX+bounds.maxX)/2*scale,oy=h/2+(bounds.minY+bounds.maxY)/2*scale,projected=new Map();
  for(const p of points)projected.set(p.name,[ox+p.p[0]*scale,oy-p.p[1]*scale]);
  for(const p of points)if(p.parent&&projected.has(p.parent)){const a=projected.get(p.parent),b=projected.get(p.name);motionLine(buf,w,h,a[0],a[1],b[0],b[1]);}
  for(const [x,y] of projected.values())for(let yy=-3;yy<=3;yy++)for(let xx=-3;xx<=3;xx++)if(xx*xx+yy*yy<=9){const px=Math.round(x)+xx,py=Math.round(y)+yy;if(px>=0&&px<w&&py>=0&&py<h){const q=(py*w+px)*3;buf[q]=245;buf[q+1]=248;buf[q+2]=255;}}
  return buf;
}
async function renderMotionMp4(bvhText,destination) {
  const parsed=parseMotionBvh(bvhText),w=320,h=320,fps=20,frames=[],bounds={minX:Infinity,maxX:-Infinity,minY:Infinity,maxY:-Infinity};
  const total=parsed.frameCount;
  for(let f=0;f<total;f++){const vals=parsed.flat.slice(f*parsed.channelCount,(f+1)*parsed.channelCount),pts=motionFramePoints(parsed.root,vals);for(const p of pts){bounds.minX=Math.min(bounds.minX,p.p[0]);bounds.maxX=Math.max(bounds.maxX,p.p[0]);bounds.minY=Math.min(bounds.minY,p.p[1]);bounds.maxY=Math.max(bounds.maxY,p.p[1]);}frames.push(pts);}
  const {spawn}=require("node:child_process");
  const ff=spawn(require("ffmpeg-static"),["-y","-loglevel","error","-f","rawvideo","-pix_fmt","rgb24","-s",w+"x"+h,"-r",String(fps),"-i","pipe:0","-an","-c:v","libx264","-preset","ultrafast","-crf","30","-pix_fmt","yuv420p","-movflags","+faststart",destination],{stdio:["pipe","ignore","pipe"]});
  let errText="";ff.stderr.on("data",d=>{errText+=d.toString();if(errText.length>3000)errText=errText.slice(-3000);});
  const done=new Promise((resolve,reject)=>{ff.on("error",reject);ff.on("close",code=>code===0?resolve():reject(new Error("FFmpeg failed: "+errText)));});
  for(const pts of frames)await new Promise((resolve,reject)=>ff.stdin.write(motionRaster(pts,bounds,w,h),e=>e?reject(e):resolve()));
  ff.stdin.end();await done;return {frames:total,duration:total/fps,width:w,height:h};
}
app.post("/api/motion/video",async(req,res)=>{
  const prompt=req.body?.prompt;
  const seconds=Number(req.body?.seconds??3);
  if(typeof prompt!=="string"||!prompt.trim()||prompt.length>240)return res.status(400).json({success:false,error:"Prompt must contain 1 to 240 characters."});
  if(!Number.isFinite(seconds)||seconds<3||seconds>60)return res.status(400).json({success:false,error:"Duration must be between 3 and 60 seconds."});
  if(motionBusy)return res.status(429).json({success:false,error:"The local motion engine is busy. Try again shortly."});
  motionBusy=true;
  const output=path.join(MOTION_ROOT,"motion-"+crypto.randomUUID()+".mp4");
  try{
    await ensureMotionRuntime();
    const actions=prompt.split(/(?:,|;|\n|،|؛|سپس|بعدش|و بعد|\bthen\b|\band then\b|\bafter that\b)/i).map(x=>x.trim()).filter(Boolean);
    const segmentCount=Math.ceil(seconds/3);
    const bvhParts=[];
    let baseHeader=null,baseFrameTime=null,totalBvhFrames=0;
    for(let index=0;index<segmentCount;index++){
      const actionIndex=Math.min(actions.length-1,Math.floor(index*actions.length/segmentCount));
      const action=actions[actionIndex]||prompt.trim();
      const chunkSeconds=Math.min(3,seconds-index*3);
      const {stdout}=await execFileAsync(MOTION_BIN,[MOTION_MODEL,action.slice(0,240),String(chunkSeconds)],{timeout:120000,maxBuffer:12*1024*1024});
      if(!stdout||!stdout.startsWith("HIERARCHY"))throw new Error("Motion model returned invalid BVH for segment "+(index+1)+".");
      const motion=parseMotionBvh(stdout);
      const motionIndex=stdout.indexOf("MOTION");
      const header=stdout.slice(0,motionIndex).trim();
      if(baseHeader===null){baseHeader=header;baseFrameTime=motion.frameTime;}
      else if(header!==baseHeader||Math.abs(motion.frameTime-baseFrameTime)>0.000001)throw new Error("Skeleton or frame rate changed between segments; MP4 assembly stopped.");
      const motionHeader=stdout.match(/MOTION\s+Frames:\s*\d+\s+Frame\s+Time:\s*[^\r\n]*\r?\n/);
      if(!motionHeader)throw new Error("BVH motion header could not be parsed for segment "+(index+1)+".");
      const motionBody=stdout.slice(motionIndex+motionHeader[0].length).trim();
      bvhParts.push(motionBody);
      totalBvhFrames+=motion.frameCount;
    }
    const mergedBvh=baseHeader+"\nMOTION\nFrames: "+totalBvhFrames+"\nFrame Time: "+baseFrameTime+"\n"+bvhParts.join("\n");
    const meta=await renderMotionMp4(mergedBvh,output);
    const video=await fsp.readFile(output);
    res.setHeader("Content-Type","video/mp4");
    res.setHeader("Content-Disposition",'attachment; filename="vortex-motion-'+seconds+'s.mp4"');
    res.setHeader("X-Vortex-Render",JSON.stringify({...meta,segments:segmentCount,requestedDuration:seconds,format:"mp4"}));
    return res.send(video);
  }catch(error){
    console.error("VORTEX BVH-to-MP4 error:",error.message);
    return res.status(503).json({success:false,error:"Local MP4 rendering failed.",details:error.message});
  }finally{await fsp.rm(output,{force:true}).catch(()=>{});motionBusy=false;}
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

app.get("/api/video/queue-status", (req, res) => {
  const configured = Boolean(process.env.VORTEX_AGNES_API_KEY);
  res.json({
    success: true,
    check: "local_queue",
    queueSystem: "single_slot",
    state: videoBusy ? "busy" : "idle",
    acceptingRequests: configured && !videoBusy,
    providerQueuePosition: null,
    note: "This checks VORTEX server availability only. Agnes queue position is available only after a task is created."
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
