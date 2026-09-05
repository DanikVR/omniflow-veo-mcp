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

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'omniflow', version: '1.1.2' };
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
  },
  required: ['prompt'],
};

const TOOLS = [
  {
    name: 'flow_status',
    description: 'Bridge and extension state: whether the OmniFlow extension is connected, whether a Google Flow project tab is open, what is queued — plus `extension.director`, the director playbook. Call it BEFORE generating: without a live Flow tab tasks just pile up. If `license` is "expired" the extension has no access: ask the user to activate a key at lingoflow.pro/omniflow; the queue resumes by itself after activation.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('/health'),
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
      },
      required: ['items'],
    },
    handler: (args) => api('/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: args.items,
        opts: { folder: args.folder, prefix: args.prefix, model: args.model, aspect: args.aspect, length: args.length, resolution: args.resolution, chain: args.chain },
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
      return { ...view, timedOut: !view.finished };
    },
  },
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
        instructions: 'You are the director for Google Flow (Veo 3 / Omni 1.1), not a silent executor. Reply in the user\'s language. ALWAYS call flow_status first: it returns `extension.director` — the director playbook sent by the OmniFlow Chrome extension (dramaturgy map, camera moves, product presets, scene chaining, sound layers). Follow it. If `extension.connected` is false — ask the user to install and open the OmniFlow extension (https://lingoflow.pro/omniflow) and to open a project at labs.google/fx/tools/flow; if `license` is "expired" — ask them to activate a key, the queue resumes by itself. Workflow: ask 2–4 option questions (goal, platform 9:16/16:9/1:1, materials as absolute paths), propose 2–3 scenarios, then flow_generate → flow_wait → show the files → offer edits via flow_edit. Prompts go to Flow in English; on-screen text stays in the user\'s language. The playbook in flow_status is the single source of truth: when it and this note disagree, the playbook wins.',
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
