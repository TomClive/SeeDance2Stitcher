const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const zlib = require("zlib");
const { execFile } = require("child_process");
const { spawn } = require("child_process");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const UPLOADS = path.join(DATA, "uploads");
const OUTPUTS = path.join(DATA, "outputs");
const SAMPLE_1 = process.env.SAMPLE_VIDEO1 || path.join(ROOT, "samples", "video1.mp4");
const SAMPLE_2 = process.env.SAMPLE_VIDEO2 || path.join(ROOT, "samples", "video2.mp4");
const WINDOWS_FFMPEG = "C:\\Program Files\\ffmpeg-6.0-full_build-shared\\bin\\ffmpeg.exe";
const WINDOWS_FFPROBE = "C:\\Program Files\\ffmpeg-6.0-full_build-shared\\bin\\ffprobe.exe";
const DEFAULT_FFMPEG = process.platform === "win32" ? WINDOWS_FFMPEG : "ffmpeg";
const DEFAULT_FFPROBE = process.platform === "win32" ? WINDOWS_FFPROBE : "ffprobe";
const FFMPEG = process.env.FFMPEG_PATH || DEFAULT_FFMPEG;
const FFPROBE = process.env.FFPROBE_PATH || DEFAULT_FFPROBE;
const ANALYSIS_WIDTH = 160;
const ANALYSIS_HEIGHT = 90;
const WINDOW_FRAMES = 96;

const sessions = new Map();
const exportJobs = new Map();

function ffToolInfo(command) {
  const executable = String(command).split(/[\\/]/).pop().toLowerCase();
  if (executable.startsWith("ffprobe")) return { name: "FFprobe", env: "FFPROBE_PATH" };
  if (executable.startsWith("ffmpeg")) return { name: "FFmpeg", env: "FFMPEG_PATH" };
  return null;
}

function explainMissingTool(error, command) {
  if (error.code !== "ENOENT") return error.message;
  const tool = ffToolInfo(command);
  if (!tool) return error.message;
  return `${tool.name} was not found at "${command}". Install FFmpeg or set ${tool.env} before running npm start.`;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 * 256, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr?.toString?.() || "";
        error.message = explainMissingTool(error, command);
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function ensureDirs() {
  await fsp.mkdir(UPLOADS, { recursive: true });
  await fsp.mkdir(OUTPUTS, { recursive: true });
}

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mp4": "video/mp4",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png"
  }[ext] || "application/octet-stream";
}

function cleanBaseName(name, fallback) {
  const base = path.basename(name || fallback || "clip", path.extname(name || ""));
  const safe = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return safe || fallback || "clip";
}

function outputName(session, options) {
  const parts = [
    session.names.video1,
    session.names.video2
  ];
  if (options.trimEnd1 > 0 || options.trimStart2 > 0) {
    const trimParts = [];
    if (options.trimEnd1 > 0) trimParts.push(`v1e${options.trimEnd1}f`);
    if (options.trimStart2 > 0) trimParts.push(`v2s${options.trimStart2}f`);
    parts.push(`rm-${trimParts.join("-")}`);
  } else {
    parts.push("no-trim");
  }
  parts.push(options.mode);
  if (options.blendFrames > 0 && options.mode === "blend") parts.push(`blend${options.blendFrames}f`);
  if (options.toneMatch && options.toneScope === "full") parts.push("tonefull");
  if (options.toneMatch && options.toneScope !== "full" && options.toneFrames > 0) parts.push(`tone${options.toneFrames}f`);
  if (options.interpolate) parts.push("mi");
  if (options.audioMode && options.audioMode !== "micro_crossfade") {
    parts.push(`a-${options.audioMode.replace(/_/g, "")}`);
  }
  if (options.collage) parts.push(`cmp${options.collageSeconds || 5}s`);
  return `${parts.join("_")}.mp4`;
}

function uniqueOutputPath(filename) {
  const parsed = path.parse(filename);
  let candidate = path.join(OUTPUTS, filename);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(OUTPUTS, `${parsed.name}-${index}${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

function toneFilter(tone, frames, fps, scope = "join") {
  if (!tone || frames <= 0) return "";
  const brightness = Math.max(-0.18, Math.min(0.18, Number(tone.brightnessDelta) || 0));
  const contrast = Math.max(0.8, Math.min(1.25, Number(tone.contrastRatio) || 1));
  if (Math.abs(brightness) < 0.003 && Math.abs(contrast - 1) < 0.01) return "";
  if (scope === "full") {
    return `eq=brightness=${brightness.toFixed(6)}:contrast=${contrast.toFixed(6)},`;
  }
  const duration = Math.max(1 / fps, frames / fps);
  const fade = `max(0\\,1-t/${duration.toFixed(6)})`;
  return `eq=brightness='${brightness.toFixed(6)}*${fade}':contrast='1+${(contrast - 1).toFixed(6)}*${fade}':eval=frame,`;
}

function fitFilter() {
  return "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1";
}

const LABEL_FONT = {
  " ": ["   ", "   ", "   ", "   ", "   ", "   ", "   "],
  "-": ["     ", "     ", "     ", "#####", "     ", "     ", "     "],
  "+": ["     ", "  #  ", "  #  ", "#####", "  #  ", "  #  ", "     "],
  ",": ["   ", "   ", "   ", "   ", "   ", " # ", "#  "],
  ".": ["   ", "   ", "   ", "   ", "   ", "## ", "## "],
  ":": ["   ", "## ", "## ", "   ", "## ", "## ", "   "],
  "%": ["#   #", "   # ", "  #  ", " #   ", "#   #", "     ", "     "],
  "/": ["    #", "   # ", "   # ", "  #  ", " #   ", " #   ", "#    "],
  "?": [" ### ", "#   #", "    #", "   # ", "  #  ", "     ", "  #  "],
  "0": [" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "],
  "1": ["  #  ", " ##  ", "# #  ", "  #  ", "  #  ", "  #  ", "#####"],
  "2": [" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"],
  "3": ["#### ", "    #", "    #", " ### ", "    #", "    #", "#### "],
  "4": ["#   #", "#   #", "#   #", "#####", "    #", "    #", "    #"],
  "5": ["#####", "#    ", "#    ", "#### ", "    #", "    #", "#### "],
  "6": [" ### ", "#    ", "#    ", "#### ", "#   #", "#   #", " ### "],
  "7": ["#####", "    #", "   # ", "  #  ", " #   ", " #   ", " #   "],
  "8": [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "],
  "9": [" ### ", "#   #", "#   #", " ####", "    #", "    #", " ### "],
  "A": [" ### ", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
  "B": ["#### ", "#   #", "#   #", "#### ", "#   #", "#   #", "#### "],
  "C": [" ### ", "#   #", "#    ", "#    ", "#    ", "#   #", " ### "],
  "D": ["#### ", "#   #", "#   #", "#   #", "#   #", "#   #", "#### "],
  "E": ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#####"],
  "F": ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#    "],
  "G": [" ### ", "#   #", "#    ", "# ###", "#   #", "#   #", " ### "],
  "H": ["#   #", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
  "I": ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "#####"],
  "J": ["#####", "    #", "    #", "    #", "    #", "#   #", " ### "],
  "K": ["#   #", "#  # ", "# #  ", "##   ", "# #  ", "#  # ", "#   #"],
  "L": ["#    ", "#    ", "#    ", "#    ", "#    ", "#    ", "#####"],
  "M": ["#   #", "## ##", "# # #", "#   #", "#   #", "#   #", "#   #"],
  "N": ["#   #", "##  #", "# # #", "#  ##", "#   #", "#   #", "#   #"],
  "O": [" ### ", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  "P": ["#### ", "#   #", "#   #", "#### ", "#    ", "#    ", "#    "],
  "Q": [" ### ", "#   #", "#   #", "#   #", "# # #", "#  # ", " ## #"],
  "R": ["#### ", "#   #", "#   #", "#### ", "# #  ", "#  # ", "#   #"],
  "S": [" ####", "#    ", "#    ", " ### ", "    #", "    #", "#### "],
  "T": ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  "],
  "U": ["#   #", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  "V": ["#   #", "#   #", "#   #", "#   #", "#   #", " # # ", "  #  "],
  "W": ["#   #", "#   #", "#   #", "#   #", "# # #", "## ##", "#   #"],
  "X": ["#   #", "#   #", " # # ", "  #  ", " # # ", "#   #", "#   #"],
  "Y": ["#   #", "#   #", " # # ", "  #  ", "  #  ", "  #  ", "  #  "],
  "Z": ["#####", "    #", "   # ", "  #  ", " #   ", "#    ", "#####"]
};

let crcTable;

function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      return value >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlineLength = width * 4 + 1;
  const scanlines = Buffer.alloc(scanlineLength * height);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = y * width * 4;
    const targetStart = y * scanlineLength + 1;
    rgba.copy(scanlines, targetStart, sourceStart, sourceStart + width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(scanlines)),
    pngChunk("IEND")
  ]);
}

function glyphFor(char) {
  return LABEL_FONT[char] || LABEL_FONT["?"];
}

function textPixelWidth(text, scale) {
  let width = 0;
  for (const char of text) width += (glyphFor(char)[0].length + 1) * scale;
  return Math.max(0, width - scale);
}

function wrapLabelText(text, maxWidth, scale) {
  const words = String(text).toUpperCase().replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || textPixelWidth(candidate, scale) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  if (!lines.length) lines.push("");

  let truncated = lines.length > 2;
  const visible = lines.slice(0, 2);
  for (let index = 0; index < visible.length; index += 1) {
    if (textPixelWidth(visible[index], scale) <= maxWidth) continue;
    truncated = true;
    while (visible[index] && textPixelWidth(`${visible[index]}...`, scale) > maxWidth) {
      visible[index] = visible[index].slice(0, -1).trimEnd();
    }
    visible[index] = `${visible[index]}...`;
  }
  if (truncated) {
    let last = visible[visible.length - 1] || "";
    while (last && textPixelWidth(`${last}...`, scale) > maxWidth) {
      last = last.slice(0, -1).trimEnd();
    }
    visible[visible.length - 1] = `${last}...`;
  }
  return { lines: visible, truncated };
}

function setPixel(rgba, width, x, y, color) {
  const index = (y * width + x) * 4;
  rgba[index] = color[0];
  rgba[index + 1] = color[1];
  rgba[index + 2] = color[2];
  rgba[index + 3] = color[3];
}

function fillRect(rgba, width, x, y, rectWidth, rectHeight, color) {
  for (let yy = y; yy < y + rectHeight; yy += 1) {
    for (let xx = x; xx < x + rectWidth; xx += 1) {
      setPixel(rgba, width, xx, yy, color);
    }
  }
}

function drawBitmapText(rgba, width, x, y, line, scale) {
  let cursor = x;
  for (const char of line) {
    const glyph = glyphFor(char);
    for (let gy = 0; gy < glyph.length; gy += 1) {
      for (let gx = 0; gx < glyph[gy].length; gx += 1) {
        if (glyph[gy][gx] !== "#") continue;
        fillRect(rgba, width, cursor + gx * scale, y + gy * scale, scale, scale, [255, 255, 255, 255]);
      }
    }
    cursor += (glyph[0].length + 1) * scale;
  }
}

async function writeLabelImage(text, targetPath) {
  const paddingX = 16;
  const paddingY = 12;
  const lineGap = 8;
  const maxWidth = 1232;
  let scale = 4;
  let wrapped = wrapLabelText(text, maxWidth - paddingX * 2, scale);
  while (wrapped.truncated && scale > 2) {
    scale -= 1;
    wrapped = wrapLabelText(text, maxWidth - paddingX * 2, scale);
  }

  const textWidth = Math.max(...wrapped.lines.map(line => textPixelWidth(line, scale)));
  const width = Math.min(maxWidth, Math.max(1, textWidth + paddingX * 2));
  const height = paddingY * 2 + wrapped.lines.length * 7 * scale + (wrapped.lines.length - 1) * lineGap;
  const rgba = Buffer.alloc(width * height * 4);
  fillRect(rgba, width, 0, 0, width, height, [0, 0, 0, 174]);
  wrapped.lines.forEach((line, index) => {
    drawBitmapText(rgba, width, paddingX, paddingY + index * (7 * scale + lineGap), line, scale);
  });
  await fsp.writeFile(targetPath, encodePng(width, height, rgba));
}

function stitchLabel(options, tone) {
  const parts = [];
  if (options.trimStart2 > 0) parts.push(`-${options.trimStart2}f start v2`);
  if (options.trimEnd1 > 0) parts.push(`-${options.trimEnd1}f end v1`);
  parts.push(options.mode === "blend" ? `blend ${options.blendFrames}f` : "cut");
  if (options.toneMatch && tone) {
    const brightness = Math.abs(tone.meanDeltaPct).toFixed(1);
    const contrast = Math.abs(tone.contrastDeltaPct).toFixed(1);
    const brightnessDirection = tone.brightnessDelta >= 0 ? "+" : "-";
    const contrastDirection = tone.contrastRatio >= 1 ? "+" : "-";
    parts.push(`${brightnessDirection}${brightness}% brightness`);
    parts.push(`${contrastDirection}${contrast}% contrast`);
    parts.push(options.toneScope === "full" ? "tone all v2" : `tone ${options.toneFrames}f`);
  }
  if (options.interpolate) parts.push("motion interpolation");
  return `SMOOTH STITCH - ${parts.join(", ")}`;
}

async function serveFile(res, filePath) {
  try {
    const stat = await fsp.stat(filePath);
    res.writeHead(200, {
      "Content-Type": getMime(filePath),
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes"
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    text(res, 404, "Not found");
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) throw new Error("Missing multipart boundary");
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = [];
  let offset = 0;

  while (true) {
    const start = buffer.indexOf(boundary, offset);
    if (start === -1) break;
    let partStart = start + boundary.length;
    if (buffer.slice(partStart, partStart + 2).toString() === "--") break;
    if (buffer.slice(partStart, partStart + 2).toString() === "\r\n") partStart += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), partStart);
    if (headerEnd === -1) break;
    const headers = buffer.slice(partStart, headerEnd).toString("utf8");
    let dataStart = headerEnd + 4;
    let next = buffer.indexOf(boundary, dataStart);
    if (next === -1) break;
    let dataEnd = next - 2;
    if (dataEnd < dataStart) dataEnd = next;

    const disposition = /content-disposition:[^\r\n]+/i.exec(headers)?.[0] || "";
    const name = /name="([^"]+)"/i.exec(disposition)?.[1];
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
    parts.push({ name, filename, data: buffer.slice(dataStart, dataEnd) });
    offset = next;
  }

  return parts;
}

async function saveMultipartVideos(req) {
  const body = await readBody(req);
  const parts = parseMultipart(body, req.headers["content-type"]);
  const id = crypto.randomUUID();
  const dir = path.join(UPLOADS, id);
  await fsp.mkdir(dir, { recursive: true });
  const files = {};

  for (const part of parts) {
    if ((part.name === "video1" || part.name === "video2") && part.filename) {
      const ext = path.extname(part.filename) || ".mp4";
      const target = path.join(dir, `${part.name}${ext}`);
      await fsp.writeFile(target, part.data);
      files[part.name] = target;
      files[`${part.name}Name`] = part.filename;
    }
  }

  if (!files.video1 || !files.video2) {
    throw new Error("Upload both video1 and video2.");
  }

  return { id, video1: files.video1, video2: files.video2, video1Name: files.video1Name, video2Name: files.video2Name };
}

async function ffprobe(filePath) {
  const args = [
    "-v", "error",
    "-show_entries", "stream=codec_type,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration",
    "-show_entries", "format=duration",
    "-of", "json",
    filePath
  ];
  const { stdout } = await run(FFPROBE, args);
  const parsed = JSON.parse(stdout.toString());
  const streams = parsed.streams || [];
  const stream = streams.find(item => item.codec_type === "video") || {};
  const audio = streams.find(item => item.codec_type === "audio");
  const duration = Number(stream.duration || parsed.format?.duration || 0);
  const fps = ratioToNumber(stream.avg_frame_rate || stream.r_frame_rate || "24/1") || 24;
  const frames = Number(stream.nb_frames) || Math.round(duration * fps);
  return {
    width: Number(stream.width),
    height: Number(stream.height),
    fps,
    frames,
    duration,
    hasAudio: Boolean(audio)
  };
}

function ratioToNumber(value) {
  const [a, b] = String(value).split("/").map(Number);
  if (!a || !b) return Number(value) || 0;
  return a / b;
}

async function decodeGray(filePath) {
  const args = [
    "-v", "error",
    "-i", filePath,
    "-vf", `scale=${ANALYSIS_WIDTH}:${ANALYSIS_HEIGHT}:flags=fast_bilinear,format=gray`,
    "-f", "rawvideo",
    "-"
  ];
  const { stdout } = await run(FFMPEG, args, { encoding: "buffer" });
  const frameSize = ANALYSIS_WIDTH * ANALYSIS_HEIGHT;
  const frameCount = Math.floor(stdout.length / frameSize);
  const frames = new Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    frames[i] = stdout.subarray(i * frameSize, (i + 1) * frameSize);
  }
  return frames;
}

function stats(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += frame[i];
  const mean = sum / frame.length;
  let variance = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const d = frame[i] - mean;
    variance += d * d;
  }
  return { mean, std: Math.sqrt(variance / frame.length) || 1 };
}

function compare(a, b) {
  const sa = stats(a);
  const sb = stats(b);
  let corr = 0;
  let mse = 0;
  for (let i = 0; i < a.length; i += 1) {
    corr += ((a[i] - sa.mean) / sa.std) * ((b[i] - sb.mean) / sb.std);
    const d = (a[i] - b[i]) / 255;
    mse += d * d;
  }
  corr /= a.length;
  mse /= a.length;
  return { corr, mse };
}

function toneRecommendation(video1Frames, video2Frames, trimEnd1, trimStart2, fps) {
  const v1Index = Math.max(0, video1Frames.length - trimEnd1 - 1);
  const v2Index = Math.max(0, Math.min(video2Frames.length - 1, trimStart2));
  const a = stats(video1Frames[v1Index]);
  const b = stats(video2Frames[v2Index]);
  return toneFromStats(a, b, fps, "boundary");
}

function aggregateStats(frames) {
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i += 1) {
      const value = frame[i];
      sum += value;
      sumSq += value * value;
      count += 1;
    }
  }
  const mean = sum / Math.max(1, count);
  const variance = sumSq / Math.max(1, count) - mean * mean;
  return { mean, std: Math.sqrt(Math.max(0, variance)) || 1 };
}

function fullClipToneRecommendation(video1Frames, video2Frames, fps) {
  return toneFromStats(aggregateStats(video1Frames), aggregateStats(video2Frames), fps, "full");
}

function toneFromStats(a, b, fps, scope) {
  const brightnessDelta = (a.mean - b.mean) / 255;
  const contrastRatio = Math.max(0.5, Math.min(1.8, a.std / Math.max(1, b.std)));
  const meanPct = ((b.mean - a.mean) / 255) * 100;
  const contrastPct = ((b.std - a.std) / Math.max(1, a.std)) * 100;
  const severity = Math.max(Math.abs(meanPct), Math.abs(contrastPct) * 0.65);
  const recommended = severity >= 1.0;
  const frames = recommended ? Math.max(6, Math.min(18, Math.round(fps * 0.5))) : 0;

  return {
    recommended,
    frames,
    brightnessDelta,
    contrastRatio,
    mean1: a.mean / 255,
    mean2: b.mean / 255,
    contrast1: a.std / 255,
    contrast2: b.std / 255,
    meanDeltaPct: meanPct,
    contrastDeltaPct: contrastPct,
    note: recommended
      ? `${meanPct > 0 ? "brighter" : "darker"} by ${Math.abs(meanPct).toFixed(1)}% with ${Math.abs(contrastPct).toFixed(1)}% contrast shift.`
      : "brightness and contrast are close."
  };
}

function analyzeFrames(video1Frames, video2Frames, fps) {
  const window = Math.min(WINDOW_FRAMES, video1Frames.length, video2Frames.length);
  const tailStart = video1Frames.length - window;
  const pairMatches = [];
  let bestPair = null;

  for (let i = 0; i < window; i += 1) {
    for (let j = 0; j < window; j += 1) {
      const result = compare(video1Frames[tailStart + i], video2Frames[j]);
      const item = {
        v1Frame: tailStart + i,
        v2Frame: j,
        v1TrimEnd: video1Frames.length - 1 - (tailStart + i),
        v2TrimStart: j,
        corr: result.corr,
        mse: result.mse
      };
      if (!bestPair || item.corr > bestPair.corr) bestPair = item;
      pairMatches.push(item);
    }
  }

  pairMatches.sort((a, b) => b.corr - a.corr || a.mse - b.mse);

  const overlaps = [];
  for (let length = 1; length <= window; length += 1) {
    let corr = 0;
    let mse = 0;
    for (let k = 0; k < length; k += 1) {
      const result = compare(video1Frames[video1Frames.length - length + k], video2Frames[k]);
      corr += result.corr;
      mse += result.mse;
    }
    overlaps.push({
      frames: length,
      seconds: length / fps,
      corr: corr / length,
      mse: mse / length
    });
  }

  const sortedOverlaps = [...overlaps].sort((a, b) => {
    const scoreA = a.corr - a.mse * 2 - Math.abs(a.frames - 6) * 0.0005;
    const scoreB = b.corr - b.mse * 2 - Math.abs(b.frames - 6) * 0.0005;
    return scoreB - scoreA;
  });
  const recommended = sortedOverlaps[0] || { frames: 0, corr: 0, mse: 1 };
  const confidence = recommended.corr > 0.985 ? "high" : recommended.corr > 0.94 ? "medium" : "low";
  const trimEnd1 = 0;
  const trimStart2 = recommended.frames;
  const tone = toneRecommendation(video1Frames, video2Frames, trimEnd1, trimStart2, fps);
  const fullClipTone = fullClipToneRecommendation(video1Frames, video2Frames, fps);

  return {
    window,
    bestPair,
    recommended: {
      trimEnd1,
      trimStart2,
      overlapFrames: recommended.frames,
      overlapSeconds: recommended.seconds,
      confidence,
      corr: recommended.corr,
      mse: recommended.mse,
      note: `Detected about ${recommended.frames} overlapping frame${recommended.frames === 1 ? "" : "s"} at the join.`
    },
    tone,
    fullClipTone,
    topMatches: pairMatches.slice(0, 24),
    overlapCurve: overlaps
  };
}

async function analyseSession(id, video1, video2, names = {}) {
  const [meta1, meta2, frames1, frames2] = await Promise.all([
    ffprobe(video1),
    ffprobe(video2),
    decodeGray(video1),
    decodeGray(video2)
  ]);
  const fps = meta1.fps || meta2.fps || 24;
  const analysis = analyzeFrames(frames1, frames2, fps);
  const session = {
    id,
    video1,
    video2,
    names: {
      video1: cleanBaseName(names.video1 || video1, "video1"),
      video2: cleanBaseName(names.video2 || video2, "video2")
    },
    meta1,
    meta2,
    analysis,
    createdAt: Date.now()
  };
  sessions.set(id, session);
  return session;
}

async function handleAnalyze(req, res) {
  try {
    let id;
    let video1;
    let video2;
    let names = {};
    if ((req.headers["content-type"] || "").includes("multipart/form-data")) {
      const upload = await saveMultipartVideos(req);
      id = upload.id;
      video1 = upload.video1;
      video2 = upload.video2;
      names = { video1: upload.video1Name, video2: upload.video2Name };
    } else {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      id = crypto.randomUUID();
      video1 = body.sample ? SAMPLE_1 : body.video1;
      video2 = body.sample ? SAMPLE_2 : body.video2;
      names = body.sample ? { video1: "video1", video2: "video2" } : {};
      if (body.sample && (!fs.existsSync(video1) || !fs.existsSync(video2))) {
        throw new Error("No sample videos found. Add samples/video1.mp4 and samples/video2.mp4, or upload two clips.");
      }
    }

    if (!video1 || !video2) throw new Error("Provide two videos.");
    const session = await analyseSession(id, video1, video2, names);
    json(res, 200, publicSession(session));
  } catch (error) {
    json(res, 500, { error: error.message, detail: error.stderr || "" });
  }
}

function publicSession(session) {
  return {
    id: session.id,
    names: session.names,
    meta1: session.meta1,
    meta2: session.meta2,
    analysis: session.analysis,
    videos: {
      video1: `/media/${session.id}/1`,
      video2: `/media/${session.id}/2`
    }
  };
}

async function handleFrame(req, res, url) {
  const id = url.searchParams.get("id");
  const clip = url.searchParams.get("clip") === "2" ? "video2" : "video1";
  const frame = Math.max(0, Number(url.searchParams.get("frame") || 0));
  const session = sessions.get(id);
  if (!session) return text(res, 404, "Session not found");

  try {
    const args = [
      "-v", "error",
      "-i", session[clip],
      "-vf", `select=eq(n\\,${frame}),scale=180:-1`,
      "-frames:v", "1",
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "-"
    ];
    const { stdout } = await run(FFMPEG, args, { encoding: "buffer" });
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
    res.end(stdout);
  } catch (error) {
    json(res, 500, { error: error.message, detail: error.stderr || "" });
  }
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

async function handleExport(req, res) {
  try {
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    const session = sessions.get(body.id);
    if (!session) throw new Error("Session not found. Analyse videos first.");

    const fps = session.meta1.fps || 24;
    const trimEnd1 = clampNumber(body.trimEnd1, 0, session.meta1.frames - 1);
    const trimStart2 = clampNumber(body.trimStart2, 0, session.meta2.frames - 1);
    const blendFrames = clampNumber(body.blendFrames, 0, 48);
    const interpolate = Boolean(body.interpolate);
    const mode = body.mode === "blend" && blendFrames > 0 ? "blend" : "cut";
    const toneFrames = clampNumber(body.toneFrames, 0, 48);
    const toneScope = body.toneScope === "full" ? "full" : "join";
    const toneMatch = Boolean(body.toneMatch) && (toneScope === "full" || toneFrames > 0);
    const audioMode = ["micro_crossfade", "clean_cut", "hard_cut"].includes(body.audioMode) ? body.audioMode : "micro_crossfade";
    const output = uniqueOutputPath(outputName(session, {
      trimEnd1,
      trimStart2,
      mode,
      blendFrames,
      toneMatch,
      toneScope,
      toneFrames,
      interpolate,
      audioMode
    }));
    const end1 = Math.max(1 / fps, (session.meta1.frames - trimEnd1) / fps);
    const start2 = trimStart2 / fps;
    const blendDuration = Math.min(blendFrames / fps, Math.max(0, end1 - 1 / fps));
    const toneSource = session.analysis.tone;
    const v2ToneFilter = toneMatch ? toneFilter(toneSource, toneScope === "full" ? 1 : toneFrames, fps, toneScope) : "";

    let filter;
    if (mode === "blend") {
      const offset = Math.max(0, end1 - blendDuration);
      const expr = `A*(1-T/${blendDuration.toFixed(6)})+B*(T/${blendDuration.toFixed(6)})`;
      filter = [
        `[0:v]trim=start=0:end=${end1.toFixed(6)},setpts=PTS-STARTPTS,format=yuv420p[v0base]`,
        `[1:v]trim=start=${start2.toFixed(6)},setpts=PTS-STARTPTS,${v2ToneFilter}format=yuv420p[v1base]`,
        `[v0base]split=2[v0pre][v0fade]`,
        `[v1base]split=2[v1fade][v1post]`,
        `[v0pre]trim=start=0:end=${offset.toFixed(6)},setpts=PTS-STARTPTS[pre]`,
        `[v0fade]trim=start=${offset.toFixed(6)}:end=${end1.toFixed(6)},setpts=PTS-STARTPTS[v0b]`,
        `[v1fade]trim=start=0:end=${blendDuration.toFixed(6)},setpts=PTS-STARTPTS[v1b]`,
        `[v1post]trim=start=${blendDuration.toFixed(6)},setpts=PTS-STARTPTS[post]`,
        `[v0b][v1b]blend=all_expr='${expr}'[mix]`,
        `[pre][mix][post]concat=n=3:v=1:a=0[vout]`
      ].join(";");
    } else {
      filter = [
        `[0:v]trim=start=0:end=${end1.toFixed(6)},setpts=PTS-STARTPTS,format=yuv420p[v0]`,
        `[1:v]trim=start=${start2.toFixed(6)},setpts=PTS-STARTPTS,${v2ToneFilter}format=yuv420p[v1]`,
        `[v0][v1]concat=n=2:v=1:a=0[vout]`
      ].join(";");
    }

    if (interpolate) {
      filter += `;[vout]minterpolate=fps=${Math.round(fps * 2)}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir[vfinal]`;
    }

    const hasAudio = session.meta1.hasAudio && session.meta2.hasAudio;
    if (hasAudio) {
      const audioParts = [];
      const transitionDuration = Math.max(1.0 / fps, 5.0 / fps);
      if (mode === "blend" && blendDuration > 0) {
        audioParts.push(
          `[0:a:0]atrim=start=0:end=${end1.toFixed(6)},asetpts=PTS-STARTPTS[a0]`,
          `[1:a:0]atrim=start=${start2.toFixed(6)},asetpts=PTS-STARTPTS[a1]`,
          `[a0][a1]acrossfade=d=${blendDuration.toFixed(6)}:c1=tri:c2=tri[aout]`
        );
      } else if (audioMode === "micro_crossfade") {
        audioParts.push(
          `[0:a:0]atrim=start=0:end=${end1.toFixed(6)},asetpts=PTS-STARTPTS[a0]`,
          `[1:a:0]atrim=start=${start2.toFixed(6)},asetpts=PTS-STARTPTS[a1]`,
          `[a0][a1]acrossfade=d=${transitionDuration.toFixed(6)}:c1=qsin:c2=qsin[aout]`
        );
      } else if (audioMode === "clean_cut") {
        const fadeOutStart = Math.max(0, end1 - transitionDuration);
        audioParts.push(
          `[0:a:0]atrim=start=0:end=${end1.toFixed(6)},afade=t=out:st=${fadeOutStart.toFixed(6)}:d=${transitionDuration.toFixed(6)},asetpts=PTS-STARTPTS[a0]`,
          `[1:a:0]atrim=start=${start2.toFixed(6)},afade=t=in:st=0:d=${transitionDuration.toFixed(6)},asetpts=PTS-STARTPTS[a1]`,
          `[a0][a1]concat=n=2:v=0:a=1[aout]`
        );
      } else { // hard_cut
        audioParts.push(
          `[0:a:0]atrim=start=0:end=${end1.toFixed(6)},asetpts=PTS-STARTPTS[a0]`,
          `[1:a:0]atrim=start=${start2.toFixed(6)},asetpts=PTS-STARTPTS[a1]`,
          `[a0][a1]concat=n=2:v=0:a=1[aout]`
        );
      }
      filter += `;${audioParts.join(";")}`;
    }

    const args = [
      "-y",
      "-i", session.video1,
      "-i", session.video2,
      "-filter_complex", filter,
      "-map", interpolate ? "[vfinal]" : "[vout]",
      ...(hasAudio ? ["-map", "[aout]"] : ["-an"]),
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      ...(hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
      "-progress", "pipe:3",
      "-nostats",
      output
    ];

    const expectedSeconds = Math.max(
      0.01,
      (session.meta1.frames - trimEnd1 + session.meta2.frames - trimStart2) / fps -
        (mode === "blend" ? blendDuration : 0)
    );
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      status: "running",
      percent: 0,
      message: "Starting ffmpeg...",
      output,
      url: `/outputs/${path.basename(output)}`,
      error: "",
      stderr: "",
      startedAt: Date.now()
    };
    exportJobs.set(jobId, job);
    startExportJob(job, args, expectedSeconds);
    json(res, 200, { jobId, statusUrl: `/api/export-status?id=${jobId}` });
  } catch (error) {
    json(res, 500, { error: error.message, detail: error.stderr || "" });
  }
}

async function handleExportCollage(req, res) {
  try {
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    const session = sessions.get(body.id);
    if (!session) throw new Error("Session not found. Analyse videos first.");

    const fps = session.meta1.fps || 24;
    const trimEnd1 = clampNumber(body.trimEnd1, 0, session.meta1.frames - 1);
    const trimStart2 = clampNumber(body.trimStart2, 0, session.meta2.frames - 1);
    const blendFrames = clampNumber(body.blendFrames, 0, 48);
    const interpolate = Boolean(body.interpolate);
    const mode = body.mode === "blend" && blendFrames > 0 ? "blend" : "cut";
    const toneFrames = clampNumber(body.toneFrames, 0, 48);
    const toneScope = body.toneScope === "full" ? "full" : "join";
    const toneMatch = Boolean(body.toneMatch) && (toneScope === "full" || toneFrames > 0);
    const collageSeconds = Number(body.collageSeconds) === 2 ? 2 : 5;
    const halfCollage = collageSeconds / 2;
    const audioMode = ["micro_crossfade", "clean_cut", "hard_cut"].includes(body.audioMode) ? body.audioMode : "micro_crossfade";
    const output = uniqueOutputPath(outputName(session, {
      trimEnd1,
      trimStart2,
      mode,
      blendFrames,
      toneMatch,
      toneScope,
      toneFrames,
      interpolate,
      collage: true,
      collageSeconds,
      audioMode
    }));

    const rawEnd1 = session.meta1.frames / fps;
    const rawStart1 = Math.max(0, rawEnd1 - halfCollage);
    const rawPreLen = rawEnd1 - rawStart1;
    const end1 = Math.max(1 / fps, (session.meta1.frames - trimEnd1) / fps);
    const start2 = trimStart2 / fps;
    const blendDuration = Math.min(blendFrames / fps, Math.max(0, end1 - 1 / fps));
    const topPost = collageSeconds - rawPreLen;
    const toneSource = session.analysis.tone;
    const v2ToneFilter = toneMatch ? toneFilter(toneSource, toneScope === "full" ? 1 : toneFrames, fps, toneScope) : "";
    const scale = fitFilter();
    const bottomLabel = stitchLabel({
      trimEnd1,
      trimStart2,
      mode,
      blendFrames,
      toneMatch,
      toneScope,
      toneFrames,
      interpolate
    }, toneSource);
    const labelId = crypto.randomUUID();
    const topLabelPath = path.join(OUTPUTS, `${labelId}-top-label.png`);
    const bottomLabelPath = path.join(OUTPUTS, `${labelId}-bottom-label.png`);
    await Promise.all([
      writeLabelImage("ORIGINAL JOIN - no edit", topLabelPath),
      writeLabelImage(bottomLabel, bottomLabelPath)
    ]);

    const filters = [
      `[0:v]trim=start=${rawStart1.toFixed(6)}:end=${rawEnd1.toFixed(6)},setpts=PTS-STARTPTS,${scale},format=yuv420p[top0]`,
      `[1:v]trim=start=0:end=${topPost.toFixed(6)},setpts=PTS-STARTPTS,${scale},format=yuv420p[top1]`,
      `[top0][top1]concat=n=2:v=1:a=0[topbase]`,
      `[topbase][2:v]overlay=x=24:y=24:shortest=1:format=auto[top]`
    ];

    const hasAudio = session.meta1.hasAudio && session.meta2.hasAudio;
    const preLen = mode === "blend" ? halfCollage + blendDuration / 2 : halfCollage;
    const postLen = mode === "blend" ? halfCollage + blendDuration / 2 : halfCollage;
    const bottomStart1 = Math.max(0, end1 - preLen);
    const actualPreLen = end1 - bottomStart1;

    if (mode === "blend") {
      const offset = Math.max(0, actualPreLen - blendDuration);
      const expr = `A*(1-T/${blendDuration.toFixed(6)})+B*(T/${blendDuration.toFixed(6)})`;
      filters.push(
        `[0:v]trim=start=${bottomStart1.toFixed(6)}:end=${end1.toFixed(6)},setpts=PTS-STARTPTS,${scale},format=yuv420p[b0base]`,
        `[1:v]trim=start=${start2.toFixed(6)}:end=${(start2 + postLen).toFixed(6)},setpts=PTS-STARTPTS,${v2ToneFilter}${scale},format=yuv420p[b1base]`,
        `[b0base]split=2[b0pre][b0fade]`,
        `[b1base]split=2[b1fade][b1post]`,
        `[b0pre]trim=start=0:end=${offset.toFixed(6)},setpts=PTS-STARTPTS[bpre]`,
        `[b0fade]trim=start=${offset.toFixed(6)}:end=${actualPreLen.toFixed(6)},setpts=PTS-STARTPTS[b0b]`,
        `[b1fade]trim=start=0:end=${blendDuration.toFixed(6)},setpts=PTS-STARTPTS[b1b]`,
        `[b1post]trim=start=${blendDuration.toFixed(6)}:end=${postLen.toFixed(6)},setpts=PTS-STARTPTS[bpost]`,
        `[b0b][b1b]blend=all_expr='${expr}'[bmix]`,
        `[bpre][bmix][bpost]concat=n=3:v=1:a=0,trim=start=0:end=${collageSeconds.toFixed(6)},setpts=PTS-STARTPTS[bottombase]`
      );
      if (hasAudio) {
        filters.push(
          `[0:a:0]atrim=start=${bottomStart1.toFixed(6)}:end=${end1.toFixed(6)},asetpts=PTS-STARTPTS[ba0]`,
          `[1:a:0]atrim=start=${start2.toFixed(6)}:end=${(start2 + postLen).toFixed(6)},asetpts=PTS-STARTPTS[ba1]`,
          `[ba0][ba1]acrossfade=d=${blendDuration.toFixed(6)}:c1=tri:c2=tri,atrim=start=0:end=${collageSeconds.toFixed(6)},asetpts=PTS-STARTPTS[aout]`
        );
      }
    } else {
      filters.push(
        `[0:v]trim=start=${bottomStart1.toFixed(6)}:end=${end1.toFixed(6)},setpts=PTS-STARTPTS,${scale},format=yuv420p[bottom0]`,
        `[1:v]trim=start=${start2.toFixed(6)}:end=${(start2 + halfCollage).toFixed(6)},setpts=PTS-STARTPTS,${v2ToneFilter}${scale},format=yuv420p[bottom1]`,
        `[bottom0][bottom1]concat=n=2:v=1:a=0,trim=start=0:end=${collageSeconds.toFixed(6)},setpts=PTS-STARTPTS[bottombase]`
      );
      if (hasAudio) {
        const transitionDuration = Math.max(1.0 / fps, 5.0 / fps);
        if (audioMode === "micro_crossfade") {
          filters.push(
            `[0:a:0]atrim=start=${bottomStart1.toFixed(6)}:end=${end1.toFixed(6)},asetpts=PTS-STARTPTS[ba0]`,
            `[1:a:0]atrim=start=${start2.toFixed(6)}:end=${(start2 + halfCollage).toFixed(6)},asetpts=PTS-STARTPTS[ba1]`,
            `[ba0][ba1]acrossfade=d=${transitionDuration.toFixed(6)}:c1=qsin:c2=qsin,atrim=start=0:end=${collageSeconds.toFixed(6)},asetpts=PTS-STARTPTS[aout]`
          );
        } else if (audioMode === "clean_cut") {
          const fadeOutStart = Math.max(0, end1 - transitionDuration);
          filters.push(
            `[0:a:0]atrim=start=${bottomStart1.toFixed(6)}:end=${end1.toFixed(6)},afade=t=out:st=${fadeOutStart.toFixed(6)}:d=${transitionDuration.toFixed(6)},asetpts=PTS-STARTPTS[ba0]`,
            `[1:a:0]atrim=start=${start2.toFixed(6)}:end=${(start2 + halfCollage).toFixed(6)},afade=t=in:st=0:d=${transitionDuration.toFixed(6)},asetpts=PTS-STARTPTS[ba1]`,
            `[ba0][ba1]concat=n=2:v=0:a=1,atrim=start=0:end=${collageSeconds.toFixed(6)},asetpts=PTS-STARTPTS[aout]`
          );
        } else { // hard_cut
          filters.push(
            `[0:a:0]atrim=start=${bottomStart1.toFixed(6)}:end=${end1.toFixed(6)},asetpts=PTS-STARTPTS[ba0]`,
            `[1:a:0]atrim=start=${start2.toFixed(6)}:end=${(start2 + halfCollage).toFixed(6)},asetpts=PTS-STARTPTS[ba1]`,
            `[ba0][ba1]concat=n=2:v=0:a=1,atrim=start=0:end=${collageSeconds.toFixed(6)},asetpts=PTS-STARTPTS[aout]`
          );
        }
      }
    }

    filters.push(`[bottombase][3:v]overlay=x=24:y=24:shortest=1:format=auto[bottom]`);
    filters.push(`[top][bottom]vstack=inputs=2,format=yuv420p[vout]`);

    const args = [
      "-y",
      "-i", session.video1,
      "-i", session.video2,
      "-loop", "1", "-i", topLabelPath,
      "-loop", "1", "-i", bottomLabelPath,
      "-filter_complex", filters.join(";"),
      "-map", "[vout]",
      ...(hasAudio ? ["-map", "[aout]"] : ["-an"]),
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      ...(hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
      "-progress", "pipe:3",
      "-nostats",
      output
    ];

    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      status: "running",
      percent: 0,
      message: "Starting collage export...",
      output,
      url: `/outputs/${path.basename(output)}`,
      error: "",
      stderr: "",
      tempFiles: [topLabelPath, bottomLabelPath],
      startedAt: Date.now()
    };
    exportJobs.set(jobId, job);
    startExportJob(job, args, collageSeconds);
    json(res, 200, { jobId, statusUrl: `/api/export-status?id=${jobId}` });
  } catch (error) {
    json(res, 500, { error: error.message, detail: error.stderr || "" });
  }
}

function startExportJob(job, args, expectedSeconds) {
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const file of job.tempFiles || []) {
      fsp.unlink(file).catch(() => {});
    }
  };
  const child = spawn(FFMPEG, args, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe", "pipe"]
  });

  child.stdio[2].on("data", chunk => {
    job.stderr += chunk.toString();
    if (job.stderr.length > 20000) job.stderr = job.stderr.slice(-20000);
  });

  let progressBuffer = "";
  child.stdio[3].on("data", chunk => {
    progressBuffer += chunk.toString();
    const lines = progressBuffer.split(/\r?\n/);
    progressBuffer = lines.pop() || "";
    for (const line of lines) {
      const [key, value] = line.split("=");
      if (key === "out_time_ms" || key === "out_time_us") {
        const seconds = Number(value) / 1000000;
        if (Number.isFinite(seconds)) {
          job.percent = Math.max(job.percent, Math.min(99, Math.round((seconds / expectedSeconds) * 100)));
          job.message = `Rendering... ${job.percent}%`;
        }
      }
      if (key === "progress" && value === "end") {
        job.percent = 100;
        job.message = "Finalizing...";
      }
    }
  });

  child.on("error", error => {
    job.status = "error";
    job.error = explainMissingTool(error, FFMPEG);
    job.message = "Export failed.";
    cleanup();
  });

  child.on("close", code => {
    if (code === 0) {
      job.status = "complete";
      job.percent = 100;
      job.message = "Export complete.";
    } else if (job.status !== "error") {
      job.status = "error";
      job.error = `ffmpeg exited with code ${code}`;
      job.message = "Export failed.";
    }
    cleanup();
  });
}

function handleExportStatus(req, res, url) {
  const id = url.searchParams.get("id");
  const job = exportJobs.get(id);
  if (!job) return json(res, 404, { error: "Export job not found" });
  json(res, 200, {
    id: job.id,
    status: job.status,
    percent: job.percent,
    message: job.message,
    url: job.status === "complete" ? job.url : null,
    path: job.status === "complete" ? job.output : null,
    error: job.error,
    detail: job.status === "error" ? job.stderr : ""
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "POST" && url.pathname === "/api/analyze") return handleAnalyze(req, res);
  if (req.method === "POST" && url.pathname === "/api/export") return handleExport(req, res);
  if (req.method === "POST" && url.pathname === "/api/export-collage") return handleExportCollage(req, res);
  if (req.method === "GET" && url.pathname === "/api/export-status") return handleExportStatus(req, res, url);
  if (req.method === "GET" && url.pathname === "/api/frame") return handleFrame(req, res, url);
  if (req.method === "GET" && url.pathname.startsWith("/media/")) {
    const [, , id, clip] = url.pathname.split("/");
    const session = sessions.get(id);
    if (!session) return text(res, 404, "Session not found");
    return serveFile(res, clip === "2" ? session.video2 : session.video1);
  }
  if (req.method === "GET" && url.pathname.startsWith("/outputs/")) {
    return serveFile(res, path.join(OUTPUTS, path.basename(url.pathname)));
  }
  const target = url.pathname === "/" ? path.join(PUBLIC, "index.html") : path.join(PUBLIC, path.normalize(url.pathname));
  if (!target.startsWith(PUBLIC)) return text(res, 403, "Forbidden");
  return serveFile(res, target);
}

ensureDirs().then(() => {
  const port = Number(process.env.PORT || 4177);
  http.createServer(handleRequest).listen(port, () => {
    console.log(`SeeDance 2 Stitcher running at http://localhost:${port}`);
    console.log(`Sample videos: ${SAMPLE_1} + ${SAMPLE_2}`);
  });
}).catch(error => {
  console.error(error);
  process.exit(1);
});
