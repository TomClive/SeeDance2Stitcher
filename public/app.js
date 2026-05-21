const state = {
  files: { video1: null, video2: null },
  session: null,
  mode: "cut",
  audioMode: "micro_crossfade"
};

const els = {
  sampleButton: document.querySelector("#sampleButton"),
  analyzeButton: document.querySelector("#analyzeButton"),
  exportButton: document.querySelector("#exportButton"),
  collageButton: document.querySelector("#collageButton"),
  collage2Button: document.querySelector("#collage2Button"),
  status: document.querySelector("#status"),
  video1Input: document.querySelector("#video1Input"),
  video2Input: document.querySelector("#video2Input"),
  video1Name: document.querySelector("#video1Name"),
  video2Name: document.querySelector("#video2Name"),
  video1: document.querySelector("#video1"),
  video2: document.querySelector("#video2"),
  outputPanel: document.querySelector("#outputPanel"),
  outputVideo: document.querySelector("#outputVideo"),
  outputLink: document.querySelector("#outputLink"),
  progressWrap: document.querySelector("#progressWrap"),
  exportProgress: document.querySelector("#exportProgress"),
  progressText: document.querySelector("#progressText"),
  progressPercent: document.querySelector("#progressPercent"),
  v1Meta: document.querySelector("#v1Meta"),
  v2Meta: document.querySelector("#v2Meta"),
  suggestedFrames: document.querySelector("#suggestedFrames"),
  suggestedText: document.querySelector("#suggestedText"),
  confidence: document.querySelector("#confidence"),
  matchScore: document.querySelector("#matchScore"),
  toneScore: document.querySelector("#toneScore"),
  trimEnd1: document.querySelector("#trimEnd1"),
  trimStart2: document.querySelector("#trimStart2"),
  trimEnd1Out: document.querySelector("#trimEnd1Out"),
  trimStart2Out: document.querySelector("#trimStart2Out"),
  blendFrames: document.querySelector("#blendFrames"),
  blendFramesOut: document.querySelector("#blendFramesOut"),
  toneMatch: document.querySelector("#toneMatch"),
  toneFullClip: document.querySelector("#toneFullClip"),
  toneFrames: document.querySelector("#toneFrames"),
  toneFramesOut: document.querySelector("#toneFramesOut"),
  toneNote: document.querySelector("#toneNote"),
  interpolate: document.querySelector("#interpolate"),
  frameStrip: document.querySelector("#frameStrip"),
  cutMode: document.querySelector("#cutMode"),
  blendMode: document.querySelector("#blendMode"),
  audioSeamless: document.querySelector("#audioSeamless"),
  audioCleanCut: document.querySelector("#audioCleanCut"),
  audioHardCut: document.querySelector("#audioHardCut")
};

function setStatus(message, kind = "normal") {
  els.status.textContent = message;
  els.status.style.borderColor = kind === "error" ? "var(--danger)" : "var(--line)";
}

function setProgress(percent, message) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  els.progressWrap.hidden = false;
  els.exportProgress.value = value;
  els.progressPercent.textContent = `${Math.round(value)}%`;
  els.progressText.textContent = message || "Rendering...";
}

function fileLabel(file) {
  return file ? `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)` : "Drop or choose clip";
}

function wireDrop(zoneId, input, key, label) {
  const zone = document.querySelector(zoneId);
  input.addEventListener("change", () => {
    state.files[key] = input.files[0] || null;
    label.textContent = fileLabel(state.files[key]);
  });
  zone.addEventListener("dragover", event => {
    event.preventDefault();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", event => {
    event.preventDefault();
    zone.classList.remove("dragover");
    const file = [...event.dataTransfer.files].find(item => item.type.startsWith("video/"));
    if (!file) return;
    state.files[key] = file;
    label.textContent = fileLabel(file);
  });
}

wireDrop("#drop1", els.video1Input, "video1", els.video1Name);
wireDrop("#drop2", els.video2Input, "video2", els.video2Name);

function formatFrames(value) {
  const frames = Number(value);
  const fps = state.session?.meta1?.fps || 24;
  return `${frames} frame${frames === 1 ? "" : "s"} / ${(frames / fps).toFixed(3)}s`;
}

function updateOutputs() {
  els.trimEnd1Out.textContent = formatFrames(els.trimEnd1.value);
  els.trimStart2Out.textContent = formatFrames(els.trimStart2.value);
  els.blendFramesOut.textContent = formatFrames(els.blendFrames.value);
  els.toneFramesOut.textContent = formatFrames(els.toneFrames.value);
  syncPreviewPositions();
  renderFrames();
}

function syncPreviewPositions() {
  if (!state.session) return;
  const fps = state.session.meta1.fps || 24;
  const endTime = Math.max(0, (state.session.meta1.frames - Number(els.trimEnd1.value) - 1) / fps);
  const startTime = Number(els.trimStart2.value) / fps;
  if (Number.isFinite(endTime)) els.video1.currentTime = endTime;
  if (Number.isFinite(startTime)) els.video2.currentTime = startTime;
}

for (const input of [els.trimEnd1, els.trimStart2, els.blendFrames, els.toneFrames]) {
  input.addEventListener("input", updateOutputs);
}

els.toneFullClip.addEventListener("change", () => {
  if (els.toneFullClip.checked) els.toneMatch.checked = true;
  els.toneFrames.disabled = els.toneFullClip.checked;
  updateToneNote();
});

els.toneMatch.addEventListener("change", updateToneNote);

for (const button of [els.cutMode, els.blendMode]) {
  button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    els.cutMode.classList.toggle("active", state.mode === "cut");
    els.blendMode.classList.toggle("active", state.mode === "blend");
    if (state.mode === "cut") els.blendFrames.value = 0;
    if (state.mode === "blend" && Number(els.blendFrames.value) === 0) els.blendFrames.value = 6;
    updateOutputs();
  });
}

for (const button of [els.audioSeamless, els.audioCleanCut, els.audioHardCut]) {
  button.addEventListener("click", () => {
    state.audioMode = button.dataset.audioMode;
    els.audioSeamless.classList.toggle("active", state.audioMode === "micro_crossfade");
    els.audioCleanCut.classList.toggle("active", state.audioMode === "clean_cut");
    els.audioHardCut.classList.toggle("active", state.audioMode === "hard_cut");
  });
}

async function analyzeSample() {
  setStatus("Analysing bundled sample videos...");
  await analyzeRequest(fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sample: true })
  }));
}

async function analyzeUploaded() {
  if (!state.files.video1 || !state.files.video2) {
    setStatus("Drop or choose both videos first.", "error");
    return;
  }
  const form = new FormData();
  form.append("video1", state.files.video1);
  form.append("video2", state.files.video2);
  setStatus("Uploading and analysing the two clips...");
  await analyzeRequest(fetch("/api/analyze", { method: "POST", body: form }));
}

async function analyzeRequest(promise) {
  try {
    els.exportButton.disabled = true;
    els.collageButton.disabled = true;
    els.collage2Button.disabled = true;
    els.audioSeamless.disabled = true;
    els.audioCleanCut.disabled = true;
    els.audioHardCut.disabled = true;
    const response = await promise;
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.detail || payload.error || "Analysis failed");
    state.session = payload;
    applyAnalysis(payload);
    setStatus("Analysis complete. The sliders are set to the suggested join.");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function metaText(meta) {
  return `${meta.width}x${meta.height} · ${meta.fps.toFixed(2)} fps · ${meta.frames} frames`;
}

function applyAnalysis(payload) {
  els.video1.src = payload.videos.video1;
  els.video2.src = payload.videos.video2;
  els.v1Meta.textContent = metaText(payload.meta1);
  els.v2Meta.textContent = metaText(payload.meta2);

  const maxWindow = payload.analysis.window;
  for (const input of [els.trimEnd1, els.trimStart2]) input.max = maxWindow;
  els.blendFrames.max = Math.min(48, maxWindow);
  els.trimEnd1.value = payload.analysis.recommended.trimEnd1;
  els.trimStart2.value = payload.analysis.recommended.trimStart2;
  els.blendFrames.value = 0;
  els.toneFrames.value = payload.analysis.tone.frames;
  els.toneMatch.checked = payload.analysis.tone.recommended;
  els.toneFullClip.checked = payload.analysis.tone.recommended;
  els.toneFrames.disabled = els.toneFullClip.checked;
  state.mode = "cut";
  els.cutMode.classList.add("active");
  els.blendMode.classList.remove("active");

  state.audioMode = "micro_crossfade";
  els.audioSeamless.classList.add("active");
  els.audioCleanCut.classList.remove("active");
  els.audioHardCut.classList.remove("active");
  els.audioSeamless.disabled = false;
  els.audioCleanCut.disabled = false;
  els.audioHardCut.disabled = false;

  const rec = payload.analysis.recommended;
  els.suggestedFrames.textContent = `${rec.overlapFrames}`;
  els.suggestedText.textContent = `${rec.note} Default export keeps video 1 intact and removes that many frames from the start of video 2.`;
  els.confidence.textContent = `confidence ${rec.confidence}`;
  els.matchScore.textContent = `match ${(rec.corr * 100).toFixed(2)}%`;
  const tone = payload.analysis.tone;
  els.toneScore.textContent = `tone ${Math.abs(tone.meanDeltaPct).toFixed(1)}% / ${Math.abs(tone.contrastDeltaPct).toFixed(1)}%`;
  updateToneNote();
  els.exportButton.disabled = false;
  els.collageButton.disabled = false;
  els.collage2Button.disabled = false;
  updateOutputs();
}

function updateToneNote() {
  if (!state.session) return;
  const joinTone = state.session.analysis.tone;
  const fullTone = state.session.analysis.fullClipTone;
  if (!joinTone || !fullTone) return;
  const tone = els.toneFullClip.checked ? fullTone : joinTone;
  const action = els.toneFullClip.checked
    ? "Full video 2 match applies the join correction across the entire second clip."
    : (tone.recommended ? `Recommended: smooth clip 2 for ${tone.frames} frames.` : "Tone smoothing is optional for this join.");
  els.toneScore.textContent = `tone ${Math.abs(tone.meanDeltaPct).toFixed(1)}% / ${Math.abs(tone.contrastDeltaPct).toFixed(1)}%`;
  els.toneNote.textContent = `Join: ${joinTone.note} Full clip: ${fullTone.note} ${action}`;
  els.toneNote.classList.toggle("active", els.toneMatch.checked || tone.recommended);
}

function renderFrames() {
  if (!state.session) return;
  const fps = state.session.meta1.fps || 24;
  const trimEnd = Number(els.trimEnd1.value);
  const trimStart = Number(els.trimStart2.value);
  const lastKept = Math.max(0, state.session.meta1.frames - trimEnd - 1);
  const firstKept = Math.max(0, trimStart);
  const frames = [];
  for (let offset = -3; offset <= 0; offset += 1) {
    const frame = Math.max(0, lastKept + offset);
    frames.push({ clip: 1, frame, label: `v1 ${frame} · ${((frame / fps)).toFixed(3)}s` });
  }
  for (let offset = 0; offset <= 3; offset += 1) {
    const frame = Math.min(state.session.meta2.frames - 1, firstKept + offset);
    frames.push({ clip: 2, frame, label: `v2 ${frame} · ${((frame / fps)).toFixed(3)}s` });
  }
  els.frameStrip.innerHTML = "";
  for (const item of frames) {
    const card = document.createElement("div");
    card.className = "frame-card";
    const image = document.createElement("img");
    image.loading = "lazy";
    image.src = `/api/frame?id=${state.session.id}&clip=${item.clip}&frame=${item.frame}`;
    const label = document.createElement("span");
    label.textContent = item.label;
    card.append(image, label);
    els.frameStrip.append(card);
  }
}

async function exportVideo() {
  await startExport("/api/export", "Rendering joined video with ffmpeg. Audio will be trimmed and kept in the export.");
}

async function exportCollage() {
  await startExport("/api/export-collage", "Rendering 5-second labelled stitch collage.", { collageSeconds: 5 });
}

async function exportCollage2() {
  await startExport("/api/export-collage", "Rendering 2-second labelled stitch collage.", { collageSeconds: 2 });
}

async function startExport(endpoint, message, extra = {}) {
  if (!state.session) return;
  setStatus(message);
  setProgress(0, "Starting export...");
  els.exportButton.disabled = true;
  els.collageButton.disabled = true;
  els.collage2Button.disabled = true;
  els.audioSeamless.disabled = true;
  els.audioCleanCut.disabled = true;
  els.audioHardCut.disabled = true;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: state.session.id,
        trimEnd1: Number(els.trimEnd1.value),
        trimStart2: Number(els.trimStart2.value),
        mode: state.mode,
        blendFrames: Number(els.blendFrames.value),
        toneMatch: els.toneMatch.checked,
        toneScope: els.toneFullClip.checked ? "full" : "join",
        toneFrames: Number(els.toneFrames.value),
        interpolate: els.interpolate.checked,
        audioMode: state.audioMode,
        ...extra
      })
    });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.detail || payload.error || "Export failed");
    await pollExport(payload.statusUrl);
  } catch (error) {
    setStatus(error.message, "error");
    setProgress(0, "Export failed");
    els.exportButton.disabled = false;
    els.collageButton.disabled = false;
    els.collage2Button.disabled = false;
    els.audioSeamless.disabled = false;
    els.audioCleanCut.disabled = false;
    els.audioHardCut.disabled = false;
  }
}

async function pollExport(statusUrl) {
  while (true) {
    const response = await fetch(statusUrl);
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.detail || payload.error || "Export failed");
    setProgress(payload.percent, payload.message);

    if (payload.status === "complete") {
      els.outputPanel.hidden = false;
      els.outputVideo.src = payload.url;
      els.outputLink.href = payload.url;
      els.outputLink.textContent = payload.path;
      setStatus(`Export complete: ${payload.path}`);
      els.exportButton.disabled = false;
      els.collageButton.disabled = false;
      els.collage2Button.disabled = false;
      els.audioSeamless.disabled = false;
      els.audioCleanCut.disabled = false;
      els.audioHardCut.disabled = false;
      return;
    }

    if (payload.status === "error") {
      throw new Error(payload.detail || payload.error || "Export failed");
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

els.sampleButton.addEventListener("click", analyzeSample);
els.analyzeButton.addEventListener("click", analyzeUploaded);
els.exportButton.addEventListener("click", exportVideo);
els.collageButton.addEventListener("click", exportCollage);
els.collage2Button.addEventListener("click", exportCollage2);
updateOutputs();
