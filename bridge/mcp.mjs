#!/usr/bin/env node
/**
 * OmniFlow — MCP-сервер (stdio, JSON-RPC 2.0) поверх моста.
 *
 * Claude запускает этот файл как MCP-сервер; сервер сам поднимает мост (если он ещё не
 * поднят) и даёт инструменты: статус, генерация, правка, ожидание, отмена. Протокол
 * JSON-RPC реализован вручную, поэтому внешних зависимостей нет вообще.
 *
 * ВАЖНО: stdout — это транспорт протокола. Любая диагностика идёт ТОЛЬКО в stderr,
 * иначе клиент получит мусор вместо JSON-RPC и соединение развалится.
 */
import { startBridge, DEFAULT_PORT, HOST, TOKEN } from './server.mjs';
import { postprodTool, MONTAGE_SCHEMA } from './tesseract.mjs';
import fs from 'node:fs';
import { reviewJob, hasFfmpeg, RUBRIC, MAX_TAKES } from './qa.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'omniflow', version: '1.3.0' };
const BASE = `http://${HOST}:${DEFAULT_PORT}`;
const log = (...a) => console.error('[omniflow-mcp]', ...a);

const api = async (path, init) => {
  const opts = { ...(init || {}) };
  opts.headers = { ...(opts.headers || {}), 'x-omniflow-token': TOKEN };
  const r = await fetch(BASE + path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
};
let bridgeInfo = null;   // итог startBridge: занят ли порт чужим (устаревшим) мостом
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── описания инструментов ────────────────────────────────────────────────────

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'Prompt in ENGLISH, one line — the model reads English most reliably' },
    frames: {
      type: 'object',
      description: 'Omni 1.1 keyframe transition: paths to the first-frame and last-frame images',
      properties: { first: { type: 'string' }, last: { type: 'string' } },
    },
    characters: {
      type: 'array',
      description: 'Reference files (paths to photos OR .mp4/.mov videos) for consistency. Video: Flow uses only the first 30 s (3–10 s is ideal). Cannot be combined with frames — the slots are taken',
      items: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' } }, required: ['path'] },
    },
    mode: { type: 'string', enum: ['textToVideo', 'imageToVideo', 'components', 'textToImage', 'imageToImage'] },
    model: { type: 'string', description: 'Model label as shown in Flow, e.g. "Omni 1.1 Flash" or "Veo 3.1 Fast"' },
    aspect: { type: 'string', enum: ['16:9', '9:16', '1:1'], description: 'Do NOT pass unless the user asked: with a video reference the bridge inherits the source orientation by itself' },
    length: { type: 'number', description: 'Clip length in seconds: 4, 6, 8 or 10 (10 is the Omni maximum)' },
    count: { type: 'number', description: 'How many variants per prompt (1–4)' },
    resolution: { type: 'string', enum: ['', '360p', '720p', '1080p', '2k', '4k'] },
    useMention: { type: 'boolean', description: 'The character already exists in the Flow project: attach it by @mention by name instead of uploading the file again' },
    chain: { type: 'boolean', description: 'Scene chaining: the LAST frame of the previous finished clip becomes the first frame of this one — a seamless continuation. Set true on the 2nd and later items; cannot be combined with characters/frames.first' },
    flowAssets: { type: 'array', items: { type: 'string' }, description: 'Names of assets from the Flow project LIBRARY (videos/photos already uploaded there) to attach to the prompt. Name = file name without extension; a unique substring is enough' },
    onScreen: { type: 'string', description: 'Final montage (Tesseract installed): on-screen text of this scene in the language the user writes in. It is laid over as an editable title at montage time — then do NOT ask the model to draw text in the prompt' },
    speech: { type: 'string', description: 'Final montage: the exact spoken line of this scene (the text of the in-frame line or voice-over) — becomes subtitles with no speech recognition' },
  },
  required: ['prompt'],
};

const QA_PROP = { type: 'boolean', description: 'Auto-review: when the job is done, call flow_review (frames of every clip and seam come back as images), judge them and re-shoot defective scenes with flow_redo. Costs extra credits only for re-shoots. Off by default' };

const TOOLS = [
  {
    name: 'flow_status',
    description: 'Bridge and extension state: whether the OmniFlow extension is connected, whether a Google Flow project tab is open, what is queued — plus `extension.director`, the director playbook. Call it BEFORE generating: without a live Flow tab tasks just pile up. If `license` is "expired" the extension has no access: ask the user to activate a key at lingoflow.pro/omniflow; the queue resumes by itself after activation. `extension.vids` is the Google Vids side (tab readiness and the monthly pool of seconds for vids_generate).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const h = await api('/health');
      // На порту сидит мост старее этого (npm 1.1.2 и раньше) и уступить не умеет: он не знает
      // ведущую копию расширения и новых маршрутов — задачи может взять не та копия.
      if (bridgeInfo && bridgeInfo.occupant && bridgeInfo.occupant.outdated) {
        h.bridgeWarning = `An outdated OmniFlow bridge (rev ${bridgeInfo.occupant.rev}, pid ${bridgeInfo.occupant.pid || '?'}) holds port ${DEFAULT_PORT}. `
          + 'Ask the user to restart Claude (all sessions) so the current bridge takes the port; until then clips may land only in Downloads/omniflow.';
      }
      return h;
    },
  },
  {
    name: 'flow_generate',
    description: 'Queue a generation in the live Google Flow through the extension. Returns jobId immediately WITHOUT waiting for the clips — wait with flow_wait. File paths (frames/characters) are absolute; the bridge reads them. Paths on another machine are unreachable: ask the user to copy files to the machine where the bridge runs.',
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', description: 'Generation items, one per clip', items: ITEM_SCHEMA },
        folder: { type: 'string', description: 'Subfolder name for the results' },
        prefix: { type: 'string', description: 'File name prefix' },
        model: { type: 'string', description: 'Default model for all items' },
        aspect: { type: 'string', description: 'Default aspect ratio' },
        length: { type: 'number', description: 'Default length' },
        resolution: { type: 'string', description: 'Default resolution' },
        chain: { type: 'boolean', description: 'Chaining for all items: every next clip starts from the last frame of the previous one' },
        qa: QA_PROP,
        montage: MONTAGE_SCHEMA,
      },
      required: ['items'],
    },
    handler: (args) => api('/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: args.items,
        opts: { folder: args.folder, prefix: args.prefix, model: args.model, aspect: args.aspect, length: args.length, resolution: args.resolution, chain: args.chain, qa: !!args.qa, montage: args.montage },
      }),
    }),
  },
  {
    name: 'flow_edit',
    description: 'Edit an ALREADY FINISHED video in the Omni 1.1 editor (video-to-video): the extension opens the last clip in Flow, applies the described change and downloads the result. Requires "Trusted input" enabled in the extension. Wait for the result with flow_wait.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to change in the video (in English — the model reads it best)' },
        folder: { type: 'string', description: 'Subfolder name for the result' },
      },
      required: ['prompt'],
    },
    handler: (args) => api('/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ prompt: args.prompt, edit: true }], opts: { folder: args.folder || 'FlowEdit' } }),
    }),
  },
  {
    name: 'vids_generate',
    description: 'Queue Gemini Omni clips in Google Vids (docs.google.com/videos) through the extension — a SEPARATE monthly pool of seconds, not Flow credits. Check `extension.vids` in flow_status first: `quota.remaining` seconds left and `tabReady`; with no Vids tab the extension opens vids.new by itself. Modes (item.mode): "create" — text to video, optionally with up to 3 ingredient images (item.images, absolute png/jpeg paths; name them in the prompt as image 1/2/3); "animate" — one image (item.images[0]) brought to life by the prompt; "edit" — change the LAST Vids clip of this session by prompt ("Change X to Y, keeping everything else the same"); "extend" — continue the last clip for item.length seconds; "upscale" — last 720p clip to 1080p, no prompt needed. edit/extend/upscale work only on a clip made in the same Vids tab session (queue them right after the create item); uploading your own video for edit is blocked by Google in the EEA/UK/CH. Each clip: English prompt, 3–10 s, 9:16 or 16:9, 720p or 1080p (same cost in seconds). Returns jobId at once — wait with flow_wait; files are mp4 on disk, ready for the final montage in Tesseract (flow_postprod, montage.json) or sym_editor (SymFlow). Vids draws a small visible Gemini sparkle in the bottom-right corner.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'One item per clip',
          items: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Prompt in ENGLISH (Vids reads only English); order: Action → Shot/motion → Location → Style → Lighting → Audio' },
              length: { type: 'number', description: 'Seconds, 3–10' },
              aspect: { type: 'string', enum: ['9:16', '16:9'] },
              resolution: { type: 'string', enum: ['720p', '1080p'] },
              mode: { type: 'string', enum: ['create', 'animate', 'edit', 'extend', 'upscale'], description: 'Default "create"' },
              images: { type: 'array', items: { type: 'string' }, description: 'Absolute png/jpeg paths: up to 3 ingredients for create, exactly 1 for animate' },
              onScreen: { type: 'string', description: 'Final montage in Tesseract: on-screen text of this scene in the language the user writes in (laid over as an editable title)' },
              speech: { type: 'string', description: 'Final montage in Tesseract: the exact spoken line of this scene — becomes subtitles' },
            },
          },
        },
        folder: { type: 'string', description: 'Subfolder name for the results' },
        prefix: { type: 'string', description: 'File name prefix' },
        length: { type: 'number', description: 'Default length for all items' },
        aspect: { type: 'string', enum: ['9:16', '16:9'], description: 'Default aspect (9:16 if omitted)' },
        resolution: { type: 'string', enum: ['720p', '1080p'], description: 'Default resolution (1080p if omitted)' },
        qa: QA_PROP,
        montage: MONTAGE_SCHEMA,
      },
      required: ['items'],
    },
    handler: (args) => api('/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: (args.items || []).map((it) => ({
          ...it, target: 'vids', vidsMode: it.mode || 'create',
          prompt: it.prompt || (it.mode === 'upscale' ? 'upscale' : ''),   // апскейлу промпт не нужен, мосту — нужен
        })),
        opts: { folder: args.folder || 'Vids', prefix: args.prefix, length: args.length, aspect: args.aspect, resolution: args.resolution, target: 'vids', qa: !!args.qa, montage: args.montage },
      }),
    }),
  },
  {
    name: 'vids_avatar',
    description: 'Talking AI avatar video in Google Vids: a presenter reads your script with lip-sync (30 languages, script in the user\'s language). Does NOT spend the Vids clip seconds (pool unchanged in live tests). The extension picks the avatar by name in the «Аватары» window, types the script (needs "Trusted input"), presses Preview and then Generate, and saves the result: mp4 1280×720, its length follows the script (~2 s for 4 words, ~26 s for 60 words; 1–3 min to render). Avatar names as shown in Vids, e.g. Финли, Себастьян, Миа, Леви, Элеанор, Вильям, София, Джамал; a wrong name fails at once with the list of available ones, nothing is spent. The Chrome window with the Vids tab must stay visible (not minimized and not fully covered by another window) while the avatar renders — Vids does not render it in a hidden tab; the extension brings the tab forward itself when it can. Returns jobId — wait with flow_wait; the file is ready for montage (flow_postprod) or sym_editor.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'What the avatar says, in the user\'s language. Min ~15 words for natural delivery; audio tags via [ ] are supported by Vids' },
        avatar: { type: 'string', description: 'Avatar name as shown in Vids (e.g. "Финли"); empty = the one currently selected' },
        folder: { type: 'string', description: 'Subfolder name for the result' },
      },
      required: ['script'],
    },
    handler: (args) => api('/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ prompt: String(args.script || '').slice(0, 200) || 'avatar', script: args.script, avatar: args.avatar || '', target: 'vids', vidsMode: 'avatar' }],
        opts: { folder: args.folder || 'VidsAvatar', target: 'vids' },
      }),
    }),
  },
  {
    name: 'vids_voiceover',
    description: 'Voice-over in Google Vids (Gemini TTS, 30 languages): the script is read by the currently selected Vids voice. The extension types the script into the Vids voice-over panel (needs "Trusted input"), inserts the voice-over into the Vids video timeline AND saves the audio file (wav) to disk — use it for sym_editor / ffmpeg montage. Returns jobId — wait with flow_wait.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Text to read, in the user\'s language; audio tags in [ ] are supported by Vids' },
        folder: { type: 'string', description: 'Subfolder name for the result' },
      },
      required: ['script'],
    },
    handler: (args) => api('/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ prompt: String(args.script || '').slice(0, 120) || 'voiceover', script: args.script, target: 'vids', vidsMode: 'voiceover' }],
        opts: { folder: args.folder || 'VidsVoice', target: 'vids' },
      }),
    }),
  },
  {
    name: 'vids_music',
    description: 'Music track from Google Vids (Lyria 3.5): describe genre, mood, instruments, tempo, or give your own lyrics. The extension fills the Vids music panel, generates and saves the track(s) as audio files to disk. For background music under a clip ask for an instrumental in the prompt. Returns jobId — wait with flow_wait.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Description of the track (any language), e.g. "warm lo-fi instrumental, soft piano, 85 bpm, cozy cafe mood"' },
        folder: { type: 'string', description: 'Subfolder name for the result' },
      },
      required: ['prompt'],
    },
    handler: (args) => api('/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ prompt: args.prompt, target: 'vids', vidsMode: 'music' }],
        opts: { folder: args.folder || 'VidsMusic', target: 'vids' },
      }),
    }),
  },
  {
    name: 'vids_export',
    description: 'Export the WHOLE Google Vids video that is open in the Vids tab (all scenes, avatars, voice-over, music, captions on the timeline) as one file: mp4 (1080p, with a subtitle track) or animated gif. Vids renders it and hands it to the browser downloads; the bridge copies the file into the job folder. Returns jobId — wait with flow_wait.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['mp4', 'gif'], description: 'Default mp4' },
        folder: { type: 'string', description: 'Subfolder name for the result' },
      },
    },
    handler: (args) => api('/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ prompt: 'export ' + (args.format || 'mp4'), format: args.format || 'mp4', target: 'vids', vidsMode: 'export' }],
        opts: { folder: args.folder || 'VidsExport', target: 'vids' },
      }),
    }),
  },
  {
    name: 'flow_wait',
    description: 'Wait for a job to finish and return the file paths. Polls the bridge every 5 s up to timeoutSec.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        timeoutSec: { type: 'number', description: 'How long to wait, default 600 s (a Flow clip takes 1–3 min)' },
      },
      required: ['jobId'],
    },
    handler: async (args) => {
      const deadline = Date.now() + Math.max(10, Math.min(1800, Number(args.timeoutSec || 600))) * 1000;
      let view = await api(`/jobs/${encodeURIComponent(args.jobId)}`);
      while (!view.finished && Date.now() < deadline) {
        await sleep(5000);
        view = await api(`/jobs/${encodeURIComponent(args.jobId)}`);
      }
      const out = { ...view, timedOut: !view.finished };
      if (view.finished && view.qa && view.done) out.next = 'Auto-review is on for this job: call flow_review before showing the clips or starting the montage.';
      return out;
    },
  },
  {
    name: 'flow_review',
    description: 'Auto-review of a finished job (all clips, Flow or Vids): returns contact sheets as IMAGES — start/middle/end of every clip and both frames of every chain seam — plus measured flags (flat blank band, black or frozen stretches, clip shorter than ordered, brightness jump on a seam). Look at the images yourself and judge every scene by the rubric in the result; for a defective scene call flow_redo. Needs ffmpeg in PATH. Use it when the job was queued with qa:true, or whenever the user wants the clips checked.',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
    handler: async (args) => {
      const view = await api(`/jobs/${encodeURIComponent(args.jobId)}`);
      if (!view.finished) return { jobId: view.jobId, finished: false, hint: 'The job is still running — call flow_wait first.' };
      if (!hasFfmpeg()) return { jobId: view.jobId, error: 'ffmpeg is not in PATH — auto-review cannot cut frames. Ask the user to install ffmpeg, or look at the clips manually.' };
      const items = view.items.map((i) => ({ ...i, files: (i.files || []).map((f) => ({ file: f })) }));
      const r = reviewJob({ dir: view.dir }, items);
      const data = { jobId: view.jobId, maxTakes: MAX_TAKES, rubric: RUBRIC, warnings: r.warnings,
        clips: r.clips.map(({ sheet, seamSheet, ...c }) => c) };
      const content = [{ type: 'text', text: JSON.stringify(data, null, 2) }];
      for (const im of r.images) {
        content.push({ type: 'text', text: im.label });
        content.push({ type: 'image', data: fs.readFileSync(im.file).toString('base64'), mimeType: 'image/jpeg' });
      }
      return { __content: content, ...data };
    },
  },
  {
    name: 'flow_redo',
    description: `Re-shoot ONE scene of a finished job after flow_review found a defect. Same settings and references; pass a corrected English prompt (keep the character passport and style line word for word, fix only what failed). A chained scene restarts from the last frame of the PREVIOUS scene of this job. The new take replaces the old one in the job (and in montage.json); the old file stays on disk. Up to ${MAX_TAKES} takes per scene. \`affects\` lists the next chained scene whose seam must be reviewed again. Then flow_wait → flow_review again.`,
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        seq: { type: 'number', description: 'Scene number (seq) from flow_review' },
        prompt: { type: 'string', description: 'Corrected prompt in English; omit to re-roll the same prompt' },
        force: { type: 'boolean', description: 'Allow a take beyond the limit — ONLY when the user explicitly asked' },
      },
      required: ['jobId', 'seq'],
    },
    handler: (args) => api(`/jobs/${encodeURIComponent(args.jobId)}/redo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seq: args.seq, prompt: args.prompt, force: !!args.force }),
    }),
  },
  postprodTool({ name: 'flow_postprod', status: 'flow_status', api, sleep }),
  {
    name: 'flow_cancel',
    description: 'Remove everything that has not started generating yet. Clips already in progress are not interrupted.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('/cancel', { method: 'POST' }),
  },
];

const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
const spec = (t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema });

// ── JSON-RPC ─────────────────────────────────────────────────────────────────
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        // База знаний «режиссёра»: клиент читает instructions как подсказку сервера —
        // Claude ведёт диалог, а не молча исполняет.
        instructions: 'You are the director for Google Flow (Veo 3 / Omni 1.1), not a silent executor. Reply in the user\'s language. ALWAYS call flow_status first: it returns `extension.director` — the director playbook sent by the OmniFlow Chrome extension (dramaturgy map, camera moves, product presets, scene chaining, sound layers). Follow it. If `extension.connected` is false — ask the user to install and open the OmniFlow extension (https://lingoflow.pro/omniflow) and to open a project at labs.google/fx/tools/flow; if `license` is "expired" — ask them to activate a key, the queue resumes by itself. Workflow: ask 2–4 option questions (goal, platform 9:16/16:9/1:1, materials as absolute paths), propose 2–3 scenarios, then flow_generate → flow_wait → (with qa:true: flow_review — look at the frames, re-shoot defective scenes with flow_redo) → show the files → offer edits via flow_edit → final montage in Tesseract (see flow_postprod; ask to install it only when postproduction.shouldAsk is true). Prompts go to Flow in English; on-screen text stays in the user\'s language. The playbook in flow_status is the single source of truth: when it and this note disagree, the playbook wins.',
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS.map(spec) });
    case 'tools/call': {
      const tool = toolByName.get(String(params?.name || ''));
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        const data = await tool.handler(params?.arguments || {});
        // flow_review отдаёт картинки: готовый content идёт как есть, в structuredContent — только данные
        if (data && Array.isArray(data.__content)) {
          const { __content, ...rest } = data;
          return rpcResult(id, { content: __content, structuredContent: rest });
        }
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data });
      } catch (e) {
        return rpcResult(id, { content: [{ type: 'text', text: `Error: ${(e && e.message) || e}` }], isError: true });
      }
    }
    case 'resources/list': return rpcResult(id, { resources: [] });
    case 'prompts/list': return rpcResult(id, { prompts: [] });
    default:
      return isNotification ? null : rpcError(id, -32601, `Method not supported: ${method}`);
  }
}

// ── транспорт: по одному JSON на строку ──────────────────────────────────────
async function main() {
  const b = await startBridge();
  bridgeInfo = b;
  log(b.already ? 'bridge already running — reusing it' : 'bridge started', BASE);
  let buf = '';
  let inFlight = 0;      // сколько запросов ещё в обработке
  let ended = false;     // stdin закрыт — выходим, но лишь когда ответы дописаны
  const maybeExit = () => { if (ended && inFlight === 0) process.exit(0); };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { log('not JSON, skipping'); continue; }
      // Обработчики асинхронные (flow_wait ждёт минутами) — не блокируем разбор входящих
      inFlight++;
      handle(msg)
        .catch((e) => rpcError(msg?.id ?? null, -32603, (e && e.message) || 'internal error'))
        .then((out) => { if (out) process.stdout.write(JSON.stringify(out) + '\n'); })
        .finally(() => { inFlight--; maybeExit(); });
    }
  });
  process.stdin.on('end', () => { ended = true; maybeExit(); });
}

main().catch((e) => { log('fatal:', e); process.exit(1); });
