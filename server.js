const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const root = __dirname;

// Load local development secrets without exposing them to the browser bundle.
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

loadEnvFile(path.join(root, ".env"));
loadEnvFile(path.join(root, ".env.local"));

const port = Number(process.env.PORT || 4175);
const apiKey = process.env.DASHSCOPE_API_KEY;
const videoBaseUrl = (process.env.DASHSCOPE_VIDEO_BASE_URL || "https://dashscope.aliyuncs.com").replace(/\/$/, "");
const modelName = process.env.DASHSCOPE_VIDEO_MODEL || "wan3.0-video";
const imageModelName = process.env.DASHSCOPE_IMAGE_MODEL || "qwen-image-3.0-pro";
const imageEndpoint = process.env.DASHSCOPE_IMAGE_ENDPOINT || "/api/v1/services/aigc/image-generation/generation";
const editModelName = process.env.DASHSCOPE_VIDEO_EDIT_MODEL || "wanx2.1-vace-plus";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4"
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return readBodyBuffer(req).then(buffer => buffer.toString("utf8"));
}

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      chunks.push(chunk);
      if (size > 128 * 1024 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024, timeout: options.timeout || 0 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\n${stderr || stdout || ""}`.trim();
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function decodeDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid mask data URL.");
  return { contentType: match[1], buffer: Buffer.from(match[2], "base64") };
}

function isRemoteUrl(value) {
  return /^(https?:\/\/|oss:\/\/)/i.test(String(value || "").trim());
}

function getContentTypeForPath(filePath) {
  return mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function getExtensionForContentType(contentType) {
  const value = String(contentType || "").toLowerCase();
  if (value.includes("jpeg") || value.includes("jpg")) return ".jpg";
  if (value.includes("png")) return ".png";
  if (value.includes("webp")) return ".webp";
  return "";
}

function createApiError(message, code, status = 400, details) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.data = details;
  return error;
}

function classifyProviderError(error) {
  if (error?.code && error.code !== "PROVIDER_ERROR") return error.code;
  const text = `${error?.message || ""} ${JSON.stringify(error?.data || "")}`.toLowerCase();
  if (/abort|timeout|timed out|operation was aborted/.test(text)) return "PROVIDER_TIMEOUT";
  if (/sexual|prohibited_content|safety|moderation|unsafe/.test(text)) return "SAFETY_REJECTED";
  if (/copyright|copyrighted|content[_ ]?policy|music rights|audio rights/.test(text)) return "COPYRIGHT_REJECTED";
  if (/too small|below the minimum|at least \d+\s*x\s*\d+|short edge|image.*(?:height|width).*(?:\d+px|pixel)/.test(text)) return "IMAGE_TOO_SMALL";
  if (/403|404|400|media\.url|url scheme|unreachable|download|not found/.test(text)) return "MEDIA_UNREACHABLE";
  if (/resolution|size|dimension|pixel/.test(text)) return "INVALID_RESOLUTION";
  if (/balance|billing|arrear|insufficient|payment|quota/.test(text)) return "ACCOUNT_BILLING";
  if (/edit(ing)? task|video_edit|video editing/.test(text)) return "EDIT_TASK_REQUIRED";
  return error?.code || "PROVIDER_ERROR";
}

function errorAdvice(code) {
  return ({
    MEDIA_UNREACHABLE: "The media URL could not be downloaded. Upload the file again or use a fresh public HTTPS URL.",
    UNSUPPORTED_FORMAT: "Convert the reference to JPG or PNG and upload it again.",
    IMAGE_TOO_SMALL: "The reference image must be at least 300px on both sides; a 720px short edge is recommended.",
    VIDEO_TOO_LONG: "Reference videos must be 15.2 seconds or shorter.",
    SAFETY_REJECTED: "Remove explicit, sexual, violent, or otherwise sensitive wording and use a compliant reference image.",
    COPYRIGHT_REJECTED: "Remove specific song, artist, film, or character names. Use a generic visual or audio style instead.",
    INVALID_RESOLUTION: "Use a supported resolution: 720p, 1080p-SR, 1440p-SR, or a valid 2K+ image size.",
    ACCOUNT_BILLING: "The provider account has insufficient balance or an outstanding payment issue.",
    EDIT_TASK_REQUIRED: "Describe the new scene for generation, or use the dedicated video-edit flow.",
    PROVIDER_TIMEOUT: "The provider took too long to accept the request. Wait briefly and submit once more; do not repeatedly click while the request is processing.",
    PROVIDER_ERROR: "The provider rejected the request. Check the task details and try again."
  })[code] || "Check the request and try again.";
}

function sendApiError(res, error, fallbackStatus = 500) {
  const code = classifyProviderError(error);
  return sendJson(res, error.status || fallbackStatus, {
    error: error.message || "Unexpected server error.",
    code,
    retryable: ["MEDIA_UNREACHABLE", "ACCOUNT_BILLING", "PROVIDER_TIMEOUT", "PROVIDER_ERROR"].includes(code),
    advice: errorAdvice(code),
    details: error.data
  });
}

async function preflightRemoteUrl(rawUrl, expected = "media") {
  const url = String(rawUrl || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    throw createApiError("Media URL must use http or https.", "MEDIA_UNREACHABLE");
  }
  let response;
  try {
    response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      response = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-1023" },
        redirect: "follow",
        signal: AbortSignal.timeout(15000)
      });
    }
  } catch (cause) {
    throw createApiError(`Media URL preflight failed: ${cause.message}`, "MEDIA_UNREACHABLE");
  }
  if (!response.ok) {
    throw createApiError(`Media URL returned HTTP ${response.status}.`, "MEDIA_UNREACHABLE", 400, { status: response.status, url });
  }
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const length = Number(response.headers.get("content-length") || 0);
  if (length === 0 && response.body) await response.arrayBuffer().catch(() => null);
  if (expected === "image" && contentType && !contentType.startsWith("image/")) {
    throw createApiError("Reference URL is not an image.", "UNSUPPORTED_FORMAT", 400, { contentType });
  }
  if (expected === "video" && contentType && !contentType.startsWith("video/")) {
    throw createApiError("Reference URL is not a video.", "UNSUPPORTED_FORMAT", 400, { contentType });
  }
  return { url, contentType, contentLength: length };
}

async function probeImageSize(filePath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "json",
      filePath
    ]);
    const parsed = JSON.parse(stdout || "{}");
    const stream = parsed?.streams?.[0] || {};
    const width = Number(stream.width || 0);
    const height = Number(stream.height || 0);
    if (!width || !height) return null;
    return { width, height };
  } catch {
    return null;
  }
}

async function ensureMinimumImageSize(file) {
  const looksLikeImage = String(file.contentType || "").startsWith("image/")
    || /\.(jpe?g|png|webp|heic|avif|tiff?)$/i.test(String(file.filename || ""));
  if (!looksLikeImage) return file;

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fari-img-"));
  try {
    const inputExt = getExtensionForContentType(file.contentType) || ".jpg";
    const inputPath = path.join(tempDir, `input${inputExt}`);
    const outputPath = path.join(tempDir, "output.jpg");
    await fs.promises.writeFile(inputPath, file.buffer);
    const size = await probeImageSize(inputPath);
    if (!size) throw createApiError("The uploaded file is not a readable image.", "UNSUPPORTED_FORMAT");

    await execFileAsync("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-vf", "scale=720:720:force_original_aspect_ratio=increase,scale=2048:2048:force_original_aspect_ratio=decrease",
      "-frames:v", "1",
      "-q:v", "3",
      outputPath
    ]);
    const buffer = await fs.promises.readFile(outputPath);
    const outputSize = await probeImageSize(outputPath);
    if (!outputSize || Math.min(outputSize.width, outputSize.height) < 300) {
      throw createApiError("Reference image is below the minimum size.", "IMAGE_TOO_SMALL");
    }
    return {
      ...file,
      buffer,
      contentType: "image/jpeg",
      filename: `${path.parse(file.filename || "reference").name}.jpg`
    };
  } finally {
    await removeDirQuietly(tempDir);
  }
}

async function normalizeDashScopeMediaUrl(rawUrl, model = modelName) {
  const url = String(rawUrl || "").trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) {
    await preflightRemoteUrl(url);
    return url;
  }
  if (/^oss:\/\//i.test(url)) return url;

  const localPath = path.isAbsolute(url) ? url : path.join(root, url);
  if (!fs.existsSync(localPath)) {
    const error = new Error(`Media file was not found: ${url}`);
    error.status = 400;
    throw error;
  }

  const buffer = await fs.promises.readFile(localPath);
  const uploaded = await uploadToDashScope({
    filename: path.basename(localPath),
    contentType: getContentTypeForPath(localPath),
    buffer
  }, model);
  return uploaded.url;
}

async function probeVideoDuration(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath
  ], { timeout: 20000 });
  const duration = Number.parseFloat(String(stdout).trim());
  return Number.isFinite(duration) ? duration : 0;
}

async function validateVideoBufferDuration(file) {
  if (!String(file.contentType || "").startsWith("video/")) return;
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fari-upload-video-"));
  try {
    const inputPath = path.join(tempDir, "input");
    await fs.promises.writeFile(inputPath, file.buffer);
    let duration;
    try {
      duration = await probeVideoDuration(inputPath);
    } catch {
      throw createApiError("Uploaded video format is unsupported or unreadable.", "UNSUPPORTED_FORMAT");
    }
    if (!duration) throw createApiError("Uploaded video duration could not be read.", "UNSUPPORTED_FORMAT");
    if (duration > 15.2) {
      throw createApiError(`Reference video is ${duration.toFixed(2)} seconds long.`, "VIDEO_TOO_LONG", 400, { duration });
    }
  } finally {
    await removeDirQuietly(tempDir);
  }
}

async function validateReferenceVideo(rawUrl) {
  const url = String(rawUrl || "").trim();
  if (!url) throw createApiError("Reference video URL is empty.", "MEDIA_UNREACHABLE");
  // DashScope OSS references are already provider-hosted and cannot be probed by
  // this server; local uploads are inspected before they are converted to OSS.
  if (/^oss:\/\//i.test(url) || /^asset:\/\//i.test(url)) return url;
  if (/^https?:\/\//i.test(url)) {
    await preflightRemoteUrl(url, "video");
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fari-ref-video-"));
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw createApiError(`Reference video download returned HTTP ${response.status}.`, "MEDIA_UNREACHABLE", 400);
      const filePath = path.join(tempDir, "reference-video");
      await fs.promises.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
      const duration = await probeVideoDuration(filePath);
      if (duration > 15.2) throw createApiError(`Reference video is ${duration.toFixed(2)} seconds long.`, "VIDEO_TOO_LONG", 400, { duration });
      if (!duration) throw createApiError("Reference video duration could not be read.", "UNSUPPORTED_FORMAT");
    } catch (error) {
      if (error.code === "VIDEO_TOO_LONG") throw error;
      if (error.code) throw error;
      throw createApiError("Reference video could not be inspected.", "UNSUPPORTED_FORMAT");
    } finally {
      await removeDirQuietly(tempDir);
    }
    return url;
  }
  const localPath = path.isAbsolute(url) ? url : path.join(root, url);
  if (!fs.existsSync(localPath)) throw createApiError(`Reference video was not found: ${url}`, "MEDIA_UNREACHABLE");
  let duration;
  try {
    duration = await probeVideoDuration(localPath);
  } catch {
    throw createApiError("Reference video format is unsupported or unreadable.", "UNSUPPORTED_FORMAT");
  }
  if (duration > 15.2) throw createApiError(`Reference video is ${duration.toFixed(2)} seconds long.`, "VIDEO_TOO_LONG", 400, { duration });
  return url;
}

function validatePromptPolicy(prompt, { audio = false } = {}) {
  const value = String(prompt || "");
  const sensitive = /\b(sexual|sexually|nude|nudity|裸|色情|露骨|porn|explicit)\b/i;
  if (sensitive.test(value)) throw createApiError("Prompt contains restricted sexual content.", "SAFETY_REJECTED");
  const copyrighted = /\b(disney|pixar|marvel|harry potter|star wars|taylor swift|周杰伦|迪士尼|漫威)\b/i;
  if (copyrighted.test(value) || (audio && /\b(song|track|music)\s+by\b/i.test(value))) {
    throw createApiError("Prompt requests copyrighted content by name.", "COPYRIGHT_REJECTED");
  }
}

function normalizeImageSize(requested, ratio = "") {
  const defaults = /9\s*:\s*16|portrait|vertical/i.test(ratio)
    ? "1440*2560"
    : /1\s*:\s*1|square/i.test(ratio)
      ? "2048*2048"
      : "2560*1440";
  const match = String(requested || "").match(/(\d+)\s*[*xX]\s*(\d+)/);
  if (!match) return defaults;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width * height < 3686400) return defaults;
  return `${width}*${height}`;
}

async function removeDirQuietly(dirPath) {
  if (!dirPath) return;
  await fs.promises.rm(dirPath, { recursive: true, force: true }).catch(() => {});
}

function parseMultipart(body, contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new Error("Multipart boundary is missing.");
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const fields = {};
  let cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf(boundary, cursor);
    if (start < 0) break;
    const headerStart = start + boundary.length + 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd < 0) break;
    const headerText = body.subarray(headerStart, headerEnd).toString("utf8");
    const disposition = headerText.match(/Content-Disposition:.*?name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    const contentStart = headerEnd + 4;
    const nextBoundary = body.indexOf(boundary, contentStart);
    if (nextBoundary < 0) break;
    const contentEnd = nextBoundary - 2;
    if (disposition) {
      const name = disposition[1];
      const filename = disposition[2];
      const contentTypeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);
      fields[name] = filename
        ? { filename, contentType: contentTypeMatch?.[1]?.trim() || "application/octet-stream", buffer: body.subarray(contentStart, contentEnd) }
        : body.subarray(contentStart, contentEnd).toString("utf8");
    }
    cursor = nextBoundary;
  }
  return fields;
}

async function uploadToDashScope(file, model = modelName) {
  file = await ensureMinimumImageSize(file);
  await validateVideoBufferDuration(file);
  const policyResponse = await callDashScope(`/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" }
  });
  const data = policyResponse.data;
  if (!data) throw new Error("DashScope upload policy was empty.");
  const key = `${data.upload_dir}/${Date.now()}-${file.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const form = new FormData();
  form.append("OSSAccessKeyId", data.oss_access_key_id);
  form.append("policy", data.policy);
  form.append("Signature", data.signature);
  form.append("x-oss-object-acl", data.x_oss_object_acl);
  form.append("x-oss-forbid-overwrite", data.x_oss_forbid_overwrite);
  form.append("key", key);
  form.append("success_action_status", "200");
  form.append("file", new Blob([file.buffer], { type: file.contentType }), file.filename);
  const uploadResponse = await fetch(data.upload_host, { method: "POST", body: form });
  if (!uploadResponse.ok) throw new Error(`DashScope file upload failed with ${uploadResponse.status}.`);
  return { url: `oss://${key}`, filename: file.filename, expiresInHours: 48 };
}

async function callDashScope(endpoint, options = {}) {
  if (!apiKey) {
    const error = new Error("DASHSCOPE_API_KEY is not configured.");
    error.status = 500;
    throw error;
  }

  const response = await fetch(`${videoBaseUrl}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(data?.message || data?.error?.message || `DashScope request failed with ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function handleApi(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === "POST" && requestUrl.pathname === "/api/upload") {
      const contentType = req.headers["content-type"] || "";
      if (!contentType.startsWith("multipart/form-data")) return sendJson(res, 400, { error: "Use multipart/form-data." });
      const fields = parseMultipart(await readBodyBuffer(req), contentType);
      const file = fields.file;
      if (!file?.buffer?.length) return sendJson(res, 400, { error: "A file is required." });
      if (file.buffer.length > 120 * 1024 * 1024) return sendJson(res, 400, { error: "File must be 120MB or smaller." });
      const uploaded = await uploadToDashScope(file, requestUrl.searchParams.get("model") || modelName);
      return sendJson(res, 200, uploaded);
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/mask-video") {
      const body = JSON.parse(await readBody(req) || "{}");
      const frames = Array.isArray(body.frames) ? body.frames : [];
      const width = Math.max(16, Math.min(4096, Number(body.width || 0)));
      const height = Math.max(16, Math.min(4096, Number(body.height || 0)));
      const fps = Math.max(1, Math.min(60, Number(body.fps || 30)));
      const duration = Math.max(0.2, Math.min(120, Number(body.duration || 0)));
      if (!frames.length) return sendJson(res, 400, { error: "At least one mask frame is required." });
      if (!width || !height || !duration) return sendJson(res, 400, { error: "width, height, and duration are required." });

      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fari-mask-"));
      try {
        const totalFrames = Math.max(1, Math.ceil(duration * fps));
        const frameMap = new Map(frames.map(frame => [Number(frame.frameId), frame.maskDataUrl]));
        const blackFramePath = path.join(tempDir, "black.png");
        await execFileAsync("ffmpeg", [
          "-f", "lavfi",
          "-i", `color=c=black:s=${width}x${height}:d=0.01`,
          "-frames:v", "1",
          "-y",
          blackFramePath
        ]);
        for (let index = 1; index <= totalFrames; index += 1) {
          const dataUrl = frameMap.get(index);
          const pngPath = path.join(tempDir, `frame-${String(index).padStart(6, "0")}.png`);
          if (dataUrl) {
            const decoded = decodeDataUrl(dataUrl);
            await fs.promises.writeFile(pngPath, decoded.buffer);
          } else {
            await fs.promises.copyFile(blackFramePath, pngPath);
          }
        }
        const outputPath = path.join(tempDir, "mask.mp4");
        await execFileAsync("ffmpeg", [
          "-framerate", String(fps),
          "-i", path.join(tempDir, "frame-%06d.png"),
          "-t", String(duration),
          "-vf", `scale=${width}:${height}:flags=neighbor,format=yuv420p`,
          "-c:v", "libx264",
          "-movflags", "+faststart",
          "-y",
          outputPath
        ]);
        const buffer = await fs.promises.readFile(outputPath);
        const uploaded = await uploadToDashScope({
          filename: `mask-video-${Date.now()}.mp4`,
          contentType: "video/mp4",
          buffer
        }, editModelName);
        return sendJson(res, 200, uploaded);
      } finally {
        await removeDirQuietly(tempDir);
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/video-edit") {
      const body = JSON.parse(await readBody(req) || "{}");
      const prompt = String(body.prompt || "").trim();
      const videoUrl = String(body.video_url || "").trim();
      const maskImageUrl = String(body.mask_image_url || "").trim();
      const maskVideoUrl = String(body.mask_video_url || "").trim();
      if (!prompt) return sendJson(res, 400, { error: "Prompt is required." });
      if (!videoUrl) return sendJson(res, 400, { error: "video_url is required." });
      if (!maskImageUrl && !maskVideoUrl) return sendJson(res, 400, { error: "mask_image_url or mask_video_url is required." });
      validatePromptPolicy(prompt);
      await validateReferenceVideo(videoUrl);
      if (maskVideoUrl) await validateReferenceVideo(maskVideoUrl);

      const payload = {
        model: body.model || editModelName,
        input: {
          function: "video_edit",
          prompt,
          video_url: videoUrl,
          ...(maskVideoUrl
            ? { mask_video_url: maskVideoUrl }
            : { mask_image_url: maskImageUrl, mask_frame_id: Number(body.mask_frame_id || 1) })
        },
        parameters: {
          prompt_extend: body.prompt_extend !== false,
          mask_type: body.mask_type || "fixed",
          expand_ratio: Number(body.expand_ratio ?? 0.02),
          expand_mode: body.expand_mode || "original",
          resolution: body.resolution || "720P",
          ratio: body.ratio || "9:16",
          watermark: Boolean(body.watermark)
        }
      };

      const data = await callDashScope("/api/v1/services/aigc/video-generation/video-synthesis", {
        method: "POST",
        headers: {
          "X-DashScope-Async": "enable",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      return sendJson(res, 200, data);
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/video-synthesis") {
      const body = JSON.parse(await readBody(req) || "{}");
      const prompt = String(body.prompt || "").trim();
      if (!prompt) return sendJson(res, 400, { error: "Prompt is required." });
      validatePromptPolicy(prompt, { audio: body.generate_audio !== false });

      const rawMedia = Array.isArray(body.media) ? body.media : [];
      const media = [];
      for (const item of rawMedia) {
        const normalizedUrl = await normalizeDashScopeMediaUrl(item?.url, body.model || modelName);
        if (!normalizedUrl) continue;
        media.push({
          type: item?.type || "reference_image",
          url: normalizedUrl
        });
      }
      if (!media.length) return sendJson(res, 400, { error: "At least one valid media url is required." });

      const payload = {
        model: body.model || modelName,
        input: {
          prompt,
          media
        },
        parameters: {
          resolution: body.resolution || "720P",
          ratio: body.ratio || "adaptive",
          duration: Number(body.duration || 10),
          prompt_extend: body.prompt_extend !== false
        }
      };
      const data = await callDashScope("/api/v1/services/aigc/video-generation/video-synthesis", {
        method: "POST",
        headers: {
          "X-DashScope-Async": "enable",
          ...(media.some(item => item.url.startsWith("oss://")) ? { "X-DashScope-OssResourceResolve": "enable" } : {}),
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      return sendJson(res, 200, data);
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/keyframe-generation") {
      const body = JSON.parse(await readBody(req) || "{}");
      const prompt = String(body.prompt || "").trim();
      const images = Array.isArray(body.images) ? body.images.map(String).filter(Boolean).slice(0, 3) : [];
      const count = Math.min(Math.max(Number(body.n || 4), 1), 6);
      if (!prompt) return sendJson(res, 400, { error: "Keyframe prompt is required." });
      if (!images.length) return sendJson(res, 400, { error: "Upload 1 to 3 product screenshots first." });
      validatePromptPolicy(prompt);
      const imageModel = String(body.model || imageModelName).toLowerCase();
      const requestedSize = imageModel.includes("seedream")
        ? normalizeImageSize(body.size, body.ratio || prompt)
        : body.size || "1440*2560";
      const requestedImageResolution = String(body.resolution || "").toLowerCase();
      const normalizedResolution = imageModel.includes("gemini-omni")
        ? ({ "480p": "720p", "360p": "360p", "720p": "720p", "1080p": "1080p", "4k": "4k" }[requestedImageResolution] || "720p")
        : undefined;

      const payload = {
        model: body.model || imageModelName,
        input: {
          messages: [
            {
              role: "user",
              content: [
                ...images.map(url => ({ image: url })),
                { text: prompt }
              ]
            }
          ]
        },
        parameters: {
          prompt_extend: body.prompt_extend !== false,
          prompt_extend_mode: body.prompt_extend_mode || "direct",
          n: count,
          size: requestedSize,
          ...(normalizedResolution ? { resolution: normalizedResolution } : {}),
          watermark: false
        }
      };

      const data = await callDashScope(imageEndpoint, {
        method: "POST",
        headers: {
          "X-DashScope-Async": "enable",
          ...(images.some(url => url.startsWith("oss://")) ? { "X-DashScope-OssResourceResolve": "enable" } : {}),
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      return sendJson(res, 200, data);
    }

    const taskMatch = req.url.match(/^\/api\/tasks\/([^/?#]+)/);
    if (req.method === "GET" && taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]);
      const data = await callDashScope(`/api/v1/tasks/${encodeURIComponent(taskId)}`, { method: "GET" });
      return sendJson(res, 200, data);
    }

    return sendJson(res, 404, { error: "API route not found." });
  } catch (error) {
    return sendApiError(res, error);
  }
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname);
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(root, requested));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fari video server running at http://127.0.0.1:${port}/`);
  console.log(`video generator: http://127.0.0.1:${port}/video-generator.html`);
});
