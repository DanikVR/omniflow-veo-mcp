/**
 * OmniFlow — мост между Claude (MCP/CLI) и Chrome-расширением.
 *
 * Зачем мост вообще нужен: MCP-сервер не умеет «дотянуться» до расширения, а расширение
 * не умеет быть сервером. Поэтому здесь — крошечный HTTP, куда одна сторона КЛАДЁТ задачи
 * (POST /jobs), а вторая их ЗАБИРАЕТ опросом (GET /next) и рапортует результат (POST /result).
 *
 * Состояние живёт в памяти процесса: очередь эфемерна by design — упал мост, перезапустили,
 * начали заново. На диск попадают только готовые видео (OUT_DIR) и manifest.json задания.
 *
 * ── Адресация ──────────────────────────────────────────────────────────────────────
 * По умолчанию слушаем 127.0.0.1: Claude и браузер на одной машине — настраивать нечего.
 * Если Claude работает на другом устройстве (сервер, второй ПК, облако), поднимайте мост
 * на адресе Tailscale: OF_HOST=100.x.y.z. Тайлнет шифрует трафик и не выпускает его в
 * интернет, но устройств в нём несколько — поэтому при НЕлокальной привязке мост требует
 * токен (заголовок X-OmniFlow-Token или ?token=). Токен лежит в ~/.omniflow-token.
 *
 * ── Безопасность ───────────────────────────────────────────────────────────────────
 * Режем запросы с http(s)-Origin: локальный порт видит любая открытая веб-страница (CORS
 * не мешает ей отправить POST), поэтому браузерные источники пускаем только
 * chrome-extension://. Запросы без Origin (curl, MCP) — свои.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import * as Tess from './tesseract.mjs';
import * as QA from './qa.mjs';

export const DEFAULT_PORT = Number(process.env.OF_PORT || 8787);
export const HOST = process.env.OF_HOST || '127.0.0.1';
let OUT_DIR = path.resolve(process.env.OF_OUT || path.join(process.cwd(), 'omniflow-out'));
// If the current directory is not writable (e.g. Claude Code launched from C:\Windows\System32),
// fall back to ~/omniflow-out instead of dying on startup. An explicit OF_OUT is never overridden.
function ensureOutDir() {
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); return; }
  catch (e) {
    if (process.env.OF_OUT) throw e;
    const fallback = path.join(os.homedir(), 'omniflow-out');
    log(`cannot create ${OUT_DIR} (${e.code}) — using ${fallback}`);
    OUT_DIR = fallback;
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }
}
const TOKEN_FILE = path.join(os.homedir(), '.omniflow-token');
const MAX_BODY = 96 * 1024 * 1024;      // 8с 720p в base64 ≈ 10 МБ; с запасом на пакет
const TASK_TTL_MS = 20 * 60_000;        // «зависшая» running-задача возвращается в очередь
const EXT_STALE_MS = 25_000;            // без heartbeat дольше — считаем расширение отвалившимся

const isLoopback = (h) => h === '127.0.0.1' || h === 'localhost' || h === '::1';

/** Токен доступа: ~/.omniflow-token, создаётся при первом запуске. Обязателен, когда мост
 *  слушает не на loopback — в тайлнете он не единственное устройство. */
export function loadToken() {
  try {
    if (process.env.OF_TOKEN) return process.env.OF_TOKEN.trim();
    if (fs.existsSync(TOKEN_FILE)) {
      const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (t) return t;
    }
  } catch { /* создадим ниже */ }
  const t = randomBytes(24).toString('base64url');
  try { fs.writeFileSync(TOKEN_FILE, t + '\n', { encoding: 'utf8', mode: 0o600 }); } catch { /* не сохранился — живёт до перезапуска */ }
  return t;
}
export const TOKEN = loadToken();

/** Сравнение постоянного времени: по скорости ответа токен подобрать нельзя. */
function tokenOk(given) {
  if (isLoopback(HOST)) return true;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Очередь и журнал. jobs: jobId → {id, createdAt, items:[taskId]}; tasks: taskId → задача. */
const jobs = new Map();
const tasks = new Map();
let ext = { seenAt: 0, tabReady: false, url: '', version: '', license: 'unknown', idle: '', pausedUntil: 0 };
// Вкладка Google Vids живёт отдельно от Flow: свой пульс, свой пул секунд (quota от страницы).
let vids = { seenAt: 0, tabReady: false, url: '', quota: null };
let vidsDiag = '';   // снимок страницы Vids от адаптера (аватар): отдельно от vids — пульс /vids/hello его пересобирает
const extLog = [];   // последние строки журнала расширения ({at, text}), см. /ext-log
const grab = { req: null, res: null };   // просьба забрать готовые клипы из галереи Flow и её итог (/grab)
let leader = null;                       // ведущий экземпляр расширения {inst, at}: только он получает задачи
const LEADER_TTL_MS = 90_000;            // без пульса с готовой вкладкой ведущего 90 с — место свободно
// Все экземпляры, что стучатся в мост (профили Chrome, старые копии из магазина): ключ — inst,
// у старого кода без id — «legacy-<версия>». Нужен, чтобы статус показывал ВСЕ копии, а не
// последнюю отметившуюся: 29.09 копия 1.92.0 с истёкшим ключом из соседнего профиля затирала
// статус рабочей 1.94.7, и казалось, что расширение отвалилось.
const instances = new Map();
const INST_SEEN_MS = 60_000;             // копия, молчащая дольше минуты, в статус не попадает
// Ревизия моста: новый мост, найдя порт занятым старым (MCP из npm стартует с каждой сессией
// Claude), просит его уступить порт (/handover). Поднимать при каждом изменении протокола.
export const BRIDGE_REV = 4;
let server = null;                       // HTTP-сервер этого процесса — чтобы уступить порт
let reloadWanted = false;   // POST /dev/reload → расширение перезагружается на следующем пульсе
let reloadAt = 0;           // время последней команды: экземпляр старше неё перезагружается
const targetOf = (t) => (t && t.target === 'vids' ? 'vids' : 'flow');
// Плейбук режиссёра приходит от расширения (POST /brief): мост открыт, свод правил — нет.
let brief = { text: '', digest: '', version: '' };
const BRIEF_MAX = 32_000;

const now = () => Date.now();
/** Все живые копии расширения для /health и подсказка, если их больше одной. */
function instancesBlock() {
  const live = [...instances.values()].filter((i) => now() - i.at < INST_SEEN_MS);
  const lead = leader && now() - leader.at <= LEADER_TTL_MS ? leader.inst : '';
  const list = live.map((i) => ({
    version: i.version, inst: i.inst, license: i.license, tabReady: i.tabReady,
    role: i.inst && i.inst === lead ? 'leader' : !i.inst ? 'legacy' : i.license === 'expired' ? 'no-license' : 'listener',
    secAgo: Math.round((now() - i.at) / 1000),
  }));
  const extra = list.filter((i) => i.role === 'legacy' || i.role === 'no-license');
  const warning = list.length > 1
    ? `${list.length} copies of the OmniFlow extension are connected (Chrome profiles: ${list.map((i) => `${i.version || '?'} ${i.role}`).join(', ')}). `
      + 'Only the leader (the copy with an open Flow project and a valid key) receives tasks; the others just listen. '
      + (extra.length ? `Tell the user to remove the extra copy (${extra.map((i) => i.version).join(', ')}) in chrome://extensions of the Chrome profile where it is installed — it does not break generation, it only clutters the status.` : '')
    : '';
  return { instances: list, instancesWarning: warning };
}
const log = (...a) => console.error('[omniflow]', ...a);   // stderr: stdout is taken by the MCP protocol

/** Картинка с диска → dataURL (расширение кладёт её в слот кадра через DataTransfer). */
function fileToDataUrl(p) {
  const abs = path.resolve(p);
  const buf = fs.readFileSync(abs);
  const ext2 = path.extname(abs).toLowerCase();
  // видео тоже допустимый референс/материал (Omni: video-to-video, ingredients)
  const mime = ext2 === '.png' ? 'image/png' : ext2 === '.webp' ? 'image/webp'
    : ext2 === '.gif' ? 'image/gif'
    : ext2 === '.mp4' || ext2 === '.m4v' ? 'video/mp4'
    : ext2 === '.webm' ? 'video/webm'
    : ext2 === '.mov' ? 'video/quicktime'
    : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** Размеры кадра из mp4/mov (атом tkhd) — чтобы формат ролика наследовался от исходника:
 *  горизонтальный референс → 16:9, вертикальный → 9:16, квадрат → 1:1. */
function videoAspect(p) {
  try {
    const buf = fs.readFileSync(path.resolve(p));
    let best = null;
    let i = buf.indexOf('tkhd');
    while (i > 0) {
      const ver = buf[i + 4];
      // tkhd: version+flags(4) → v0: create/mod/trackId/res/dur = 20 байт, v1: 32 байта;
      // далее reserved(8) layer(2) altGroup(2) volume(2) res(2) matrix(36) → width/height (16.16)
      const off = i + 4 + 4 + (ver === 1 ? 32 : 20) + 8 + 2 + 2 + 2 + 2 + 36;
      if (off + 8 <= buf.length) {
        let w = buf.readUInt32BE(off) / 65536;
        let h = buf.readUInt32BE(off + 4) / 65536;
        // Матрица поворота (36 байт перед размерами): телефон пишет кадр «лёжа» и ставит
        // 90°/270° — реальная ориентация обратная, меняем стороны местами.
        const ma = buf.readInt32BE(off - 36), mb = buf.readInt32BE(off - 32);
        const mc = buf.readInt32BE(off - 24), md = buf.readInt32BE(off - 20);
        if (ma === 0 && md === 0 && mb !== 0 && mc !== 0) { const t = w; w = h; h = t; }
        if (w > 0 && h > 0 && (!best || w * h > best.w * best.h)) best = { w, h };
      }
      i = buf.indexOf('tkhd', i + 4);
    }
    if (!best) return '';
    const r = best.w / best.h;
    return r > 1.2 ? '16:9' : r < 0.85 ? '9:16' : '1:1';
  } catch { return ''; }
}

/** Нормализация одного элемента задания: пути к картинкам разворачиваются в dataURL здесь,
 *  на стороне моста — расширение получает готовые данные и не лезет в файловую систему. */
function normalizeItem(raw, opts) {
  const it = raw && typeof raw === 'object' ? raw : {};
  const prompt = String(it.prompt || '').trim();
  if (!prompt) throw new Error('item has no prompt');
  const frames = it.frames && typeof it.frames === 'object' ? it.frames : null;
  const task = {
    id: randomUUID(),
    status: 'queued',
    createdAt: now(),
    updatedAt: now(),
    prompt,
    // то же правило, что в панели: режим следует из материалов, а не из умолчания
    mode: it.mode || (frames ? 'imageToVideo'
      : ((Array.isArray(it.characters) && it.characters.length) ? 'components' : 'textToVideo')),
    model: it.model || opts.model || '',
    aspect: it.aspect || opts.aspect || '',
    length: it.length || opts.length || null,
    count: Math.max(1, Math.min(4, Number(it.count || opts.count || 1))),
    resolution: it.resolution || opts.resolution || '',
    edit: !!it.edit,                 // правка ОТКРЫТОГО/последнего видео в редакторе Omni (video-to-video)
    flowAssets: Array.isArray(it.flowAssets) ? it.flowAssets.slice(0, 6).map(String) : [],   // имена из библиотеки Flow
    useMention: !!it.useMention,                  // «только @имя» — без повторной заливки файла
    chain: !!(it.chain || (opts && opts.chain)),   // сшивка сцен: последний кадр клипа N → первый кадр клипа N+1
    // Для финального монтажа (Tesseract): надпись в кадре и реплика — данными, а не пикселями
    onScreen: it.onScreen ? String(it.onScreen).slice(0, 300) : '',
    speech: it.speech ? String(it.speech).slice(0, 600) : '',
    frames: null,
    characters: [],
    files: [],
    error: null,
    target: (it.target || opts.target) === 'vids' ? 'vids' : 'flow',   // куда идёт задача: Flow или Google Vids
  };
  if (task.target === 'vids') {
    // Vids: только Omni, 3–10 с любым целым, 16:9 или 9:16, 720p/1080p (1080p стоит столько же секунд пула)
    task.mode = 'textToVideo';
    task.length = Math.max(3, Math.min(10, Math.round(Number(it.length || opts.length || 8))));
    task.aspect = (it.aspect || opts.aspect) === '16:9' ? '16:9' : '9:16';
    task.resolution = (it.resolution || opts.resolution) === '720p' ? '720p' : '1080p';
    task.count = 1;
    // Режим Vids: create (текст + до 3 картинок-ингредиентов), animate (картинка → видео),
    // edit / extend / upscale — над последним клипом Vids этой вкладки.
    const vm = String(it.vidsMode || it.mode || 'create');
    task.vidsMode = ['create', 'animate', 'edit', 'extend', 'upscale', 'avatar', 'probe', 'voiceover', 'music', 'export'].includes(vm) ? vm : 'create';
    if (task.vidsMode === 'avatar') {
      // ИИ-аватар: сценарий на любом из 30 языков Vids, аватар — по имени из панели (пусто = текущий)
      task.script = String(it.script || it.prompt || '').slice(0, 5000);
      task.avatar = String(it.avatar || '').slice(0, 60);
      task.debugShots = !!it.debugShots;   // dev: кадры выбора аватара в omniflow-out/_shots
    }
    if (task.vidsMode === 'voiceover') task.script = String(it.script || it.prompt || '').slice(0, 5000);
    if (task.vidsMode === 'export') task.format = String(it.format || 'mp4').toLowerCase() === 'gif' ? 'gif' : 'mp4';
    if (task.vidsMode === 'probe') {   // dev: осмотр панели Vids
      task.panel = String(it.panel || '').replace(/[^a-z-]/g, '').slice(0, 40);
      task.clicks = Array.isArray(it.clicks) ? it.clicks.slice(0, 12).map((c) => String(c).slice(0, 200)) : [];
    }
    const imgs = Array.isArray(it.images) ? it.images : [];
    task.images = imgs.slice(0, task.vidsMode === 'animate' ? 1 : 3).map((p) => {
      const abs = path.resolve(String(typeof p === 'object' && p ? p.path : p));
      if (!/\.(png|jpe?g)$/i.test(abs)) throw new Error(`Vids принимает только png и jpeg: ${abs}`);
      return { name: path.basename(abs), dataUrl: fileToDataUrl(abs) };
    });
    if (task.vidsMode === 'animate' && !task.images.length) throw new Error('vids animate: нужна картинка в images');
    if (task.vidsMode === 'upscale' && !task.prompt) task.prompt = 'upscale';
    return task;
  }
  if (frames && (frames.first || frames.last)) {
    task.frames = {
      first: frames.first ? fileToDataUrl(frames.first) : null,
      last: frames.last ? fileToDataUrl(frames.last) : null,
    };
  }
  const chars = Array.isArray(it.characters) ? it.characters : [];
  const BIG = 8 * 1024 * 1024;   // крупнее — не гоняем base64 через messaging, отдаём путь:
  for (const c of chars.slice(0, 8)) {                        // Chrome прочитает файл сам (CDP)
    const p = typeof c === 'string' ? c : c && c.path;
    if (!p) continue;
    const abs = path.resolve(p);
    let big = false;
    try { big = fs.statSync(abs).size > BIG; } catch { /* нет файла — упадём ниже на чтении */ }
    const entry = { name: (typeof c === 'object' && c.name) || path.basename(abs).replace(/\.[a-z0-9]+$/i, '') };
    entry.baseName = path.basename(abs).replace(/\.[a-z0-9]+$/i, '');   // имя в библиотеке Flow = имя файла
    // Видео — ВСЕГДА по пути: Flow игнорирует синтетическую подачу видеофайла в поле,
    // работает только настоящая (CDP DOM.setFileInputFiles). Фото — dataUrl, как раньше.
    const isVideo = /\.(mp4|m4v|webm|mov|3gp|avi)$/i.test(abs);
    if (big || isVideo) entry.filePath = abs; else entry.dataUrl = fileToDataUrl(abs);
    task.characters.push(entry);
  }
  // формат не задан явно, но есть видео-референс — наследуем ориентацию исходника
  if (!task.aspect) {
    for (const c of chars) {
      const cp = typeof c === 'string' ? c : c && c.path;
      if (cp && /\.(mp4|m4v|mov)$/i.test(String(cp))) {
        const a = videoAspect(cp);
        if (a) { task.aspect = a; task.aspectAuto = true; }
        break;
      }
    }
  }
  return task;
}

/** Срез текущей работы для панели: какое задание идёт, какая сцена, сколько готово.
 *  Без этого интерфейс молчит 1–3 минуты, пока Flow рисует клип. */
function currentWork() {
  const run = [...tasks.values()].find((t) => t.status === 'running');
  const t = run || [...tasks.values()].filter((x) => x.status === 'queued').sort((a, b) => (a.seq || 0) - (b.seq || 0))[0];
  if (!t) {
    const last = [...tasks.values()].filter((x) => x.finishedAt).sort((a, b) => b.finishedAt - a.finishedAt)[0];
    return last ? { state: 'idle', lastAt: last.finishedAt, lastStatus: last.status } : { state: 'idle' };
  }
  const job = jobs.get(t.jobId);
  const items = job ? job.items.map((id) => tasks.get(id)).filter(Boolean) : [t];
  return {
    state: run ? 'running' : 'queued',
    jobId: t.jobId || null,
    folder: job && job.dir ? String(job.dir).split(/[\\/]/).pop() : null,
    seq: t.seq || 1,
    total: items.length,
    done: items.filter((x) => x.status === 'done').length,
    failed: items.filter((x) => x.status === 'failed').length,
    prompt: String(t.prompt || '').slice(0, 120),
    edit: !!t.edit,
    startedSecAgo: t.startedAt ? Math.round((now() - t.startedAt) / 1000) : null,
    note: t.note || null,
  };
}

/** Задачи, готовые к выдаче: queued + running, «протухшие» по TTL (вкладку закрыли посреди работы). */
function claimable(limit, target = 'flow') {
  const out = [];
  for (const t of tasks.values()) {
    if (out.length >= limit) break;
    if (targetOf(t) !== target) continue;       // задачи Vids не уходят во вкладку Flow и наоборот
    const stale = t.status === 'running' && now() - t.updatedAt > TASK_TTL_MS;
    if (t.status === 'queued' || stale) out.push(t);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
}

/** Результат от расширения → файлы на диск. Возвращает список путей. */
function writeResults(task, results, jobDir, prefix) {
  const saved = [];
  let n = 0;
  for (const r of results || []) {
    n++;
    const kind = r && (r.kind === 'image' || r.kind === 'audio') ? r.kind : 'video';
    const dataUrl = r && r.dataUrl;
    if (!dataUrl || !/^data:/.test(dataUrl)) {
      // http(s)-ссылка без байтов: сохраняем как ссылку — качать CDN Flow можно только из вкладки
      saved.push({ kind, url: (r && r.sourceUrl) || null, file: null });
      continue;
    }
    const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
    const mime = m ? m[1] : (kind === 'image' ? 'image/jpeg' : 'video/mp4');
    // аудио (озвучка и музыка Vids): wav / mp3 / m4a / ogg по mime
    const ext2 = /png/.test(mime) ? '.png' : /webp/.test(mime) ? '.webp' : /jpe?g/.test(mime) ? '.jpg'
      : /wav/.test(mime) ? '.wav' : /mpeg|mp3/.test(mime) ? '.mp3' : /ogg|opus/.test(mime) ? '.ogg'
      : /aac|mp4a|m4a|audio\/mp4/.test(mime) ? '.m4a'
      : /webm/.test(mime) ? '.webm' : kind === 'image' ? '.jpg' : kind === 'audio' ? '.wav' : '.mp4';
    const safe = String(task.prompt).replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 48) || 'clip';
    const base = `${prefix ? prefix + ' ' : ''}${String(task.seq || 0).padStart(2, '0')} ${safe}${task.take > 1 ? ' take' + task.take : ''}${n > 1 ? ' (' + n + ')' : ''}${ext2}`;
    const file = path.join(jobDir, base);
    fs.writeFileSync(file, Buffer.from(m ? m[2] : '', 'base64'));
    saved.push({ kind, file, url: (r && r.sourceUrl) || null });
  }
  return saved;
}

/**
 * Новый Flow не отдаёт байты клипа: расширение забирает файл штатной кнопкой «Скачать сцену»,
 * и он ложится в загрузки браузера. Здесь кладём копию рядом с остальными результатами задания,
 * чтобы flow_wait возвращал такие же пути, как и раньше. Оригинал в загрузках не трогаем —
 * владелец привык забирать клипы оттуда.
 */
function adoptGrabbed(task, files, jobDir, prefix) {
  const saved = [];
  let n = 0;
  for (const src of files || []) {
    n++;
    if (!src) continue;
    const ext2 = path.extname(String(src)) || '.mp4';
    const safe = String(task.prompt).replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 48) || 'clip';
    const base = `${prefix ? prefix + ' ' : ''}${String(task.seq || 0).padStart(2, '0')} ${safe}${task.take > 1 ? ' take' + task.take : ''}${n > 1 ? ' (' + n + ')' : ''}${ext2}`;
    const file = path.join(jobDir, base);
    try { fs.copyFileSync(src, file); saved.push({ kind: 'video', file, url: null }); continue; }
    catch (e) { log(`копия не удалась: ${e && e.message}`); }
    // Копия не вышла. Отдаём путь в загрузках — но ТОЛЬКО если файл там реально есть:
    // иначе задача рапортует «готово» с путём в никуда, а человек ищет несуществующий файл.
    try { if (fs.statSync(src).size > 0) saved.push({ kind: 'video', file: String(src), url: null }); }
    catch { log(`файла нет на диске, в результат не кладу: ${src}`); }
  }
  return saved;
}

function jobView(jobId) {
  const j = jobs.get(jobId);
  if (!j) return null;
  const items = j.items.map((id) => {
    const t = tasks.get(id);
    return t ? {
      id: t.id, seq: t.seq, status: t.status, prompt: t.prompt,
      files: t.files.map((f) => f.file || f.url), error: t.error, note: t.note || null,
      timedOut: !!t.timedOut,        // частичный результат нельзя выдавать за полный
      // для автопроверки (qa.mjs): заказанная длина, сшивка, номер дубля
      length: t.length || null, chain: !!t.chain || !!t.chainFrom, take: t.take || 1,
    } : null;
  }).filter(Boolean);
  const done = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'failed').length;
  return {
    jobId, dir: j.dir, total: items.length, done, failed,
    finished: done + failed >= items.length,
    montage: j.montageFile || null,      // готовый montage.json для Tesseract
    qa: !!j.qa,                          // автопроверка включена: после готовности — flow_review
    items,
  };
}

/**
 * Пересъёмка одной сцены готового задания (автопроверка нашла брак). Новый дубль встаёт на место
 * старого в задании — montage.json и flow_wait видят уже его; старый файл остаётся на диске.
 * Сцена из цепочки начинается с последнего кадра ПРЕДЫДУЩЕЙ сцены задания, вынутого из файла:
 * у расширения в памяти лежит кадр последнего снятого клипа, а это уже совсем другая сцена.
 */
function redoScene(jobId, seq, prompt, force = false) {
  const j = jobs.get(jobId);
  if (!j) throw new Error('no such job');
  const items = j.items.map((id) => tasks.get(id)).filter(Boolean);
  if (items.some((t) => t.status === 'queued' || t.status === 'running')) {
    throw new Error('the job is still running: wait for it with flow_wait, then review and redo');
  }
  const idx = items.findIndex((t) => t.seq === seq);
  if (idx < 0) throw new Error(`no scene ${seq} in this job`);
  const old = items[idx];
  if (old.edit || old.dryRun || (targetOf(old) === 'vids' && !['create', 'animate'].includes(old.vidsMode))) {
    throw new Error('this item is not a generated scene: redo works for Flow clips and Vids create/animate');
  }
  const take = (old.take || 1) + 1;
  if (take > QA.MAX_TAKES && !force) {
    throw new Error(`scene ${seq} already has ${old.take || 1} takes — stop and tell the user what is still wrong`);
  }
  const t = {
    ...old, id: randomUUID(), status: 'queued', createdAt: now(), updatedAt: now(),
    startedAt: null, finishedAt: null, files: [], error: null, note: null, timedOut: false,
    take, redoOf: old.id, chainFirst: false,
  };
  if (prompt && String(prompt).trim()) t.prompt = String(prompt).trim();
  if ((old.chain || old.chainFrom) && idx > 0) {
    const prev = items[idx - 1];
    const pf = QA.clipFile(prev);
    if (!pf) throw new Error(`scene ${prev.seq} has no clip on disk — the chained scene ${seq} has nothing to start from`);
    fs.mkdirSync(path.join(j.dir, '_qa'), { recursive: true });
    const jpg = QA.grabFrame(pf, -0.15, path.join(j.dir, '_qa', `${String(seq).padStart(2, '0')}-t${take}-from-${prev.seq}.jpg`));
    if (!jpg) throw new Error('could not take the last frame of the previous scene (is ffmpeg in PATH?)');
    t.frames = { first: fileToDataUrl(jpg), last: (old.frames && old.frames.last) || null };
    t.mode = 'imageToVideo';
    t.chain = false;
    t.chainFrom = prev.seq;
  }
  old.replacedBy = t.id;
  j.items[idx] = t.id;
  tasks.set(t.id, t);
  const next = items[idx + 1];
  log(`redo ${jobId} scene ${seq} → take ${take}`);
  return {
    jobId, seq, take, taskId: t.id,
    // следующая сцена цепочки начиналась с кадра старого дубля — шов надо посмотреть заново
    affects: next && (next.chain || next.chainFrom) ? [next.seq] : [],
  };
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('тело запроса слишком велико')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('невалидный JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    // CORS для расширения + отсечка веб-страниц (см. шапку файла)
    const origin = req.headers.origin || '';
    if (origin && !origin.startsWith('chrome-extension://')) return send(res, 403, { error: 'origin not allowed' });
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname.replace(/\/+$/, '') || '/';

    // Токен при нелокальной привязке. /ping оставляем открытым — по нему настройки
    // расширения проверяют, что мост вообще жив, ещё до ввода токена.
    if (route !== '/ping' && !tokenOk(req.headers['x-omniflow-token'] || url.searchParams.get('token'))) {
      return send(res, 401, { error: 'OmniFlow token required (~/.omniflow-token)' });
    }

    try {
      if (req.method === 'GET' && route === '/ping') {
        return send(res, 200, { ok: true, service: 'omniflow', needsToken: !isLoopback(HOST) });
      }
      // ── журнал расширения: строки панели (вкладка Flow + фон) доходят до моста, чтобы
      //    Claude видел, на каком шаге встала съёмка, без скриншота панели (27.09) ──
      if (req.method === 'POST' && route === '/ext-log') {
        const b = await readBody(req);
        for (const l of (Array.isArray(b.lines) ? b.lines : []).slice(0, 200)) extLog.push({ at: Number(l.at) || now(), text: String(l.text || '').slice(0, 400) });
        if (extLog.length > 600) extLog.splice(0, extLog.length - 600);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && route === '/ext-log') {
        const n = Math.min(600, Number(url.searchParams.get('n')) || 120);
        return send(res, 200, { lines: extLog.slice(-n).map((l) => `${new Date(l.at).toISOString().slice(11, 19)}  ${l.text}`) });
      }
      // ── статус: жив ли мост, видит ли расширение вкладку Flow ──
      if (req.method === 'GET' && route === '/health') {
        const alive = now() - ext.seenAt < EXT_STALE_MS;
        const queued = [...tasks.values()].filter((t) => t.status === 'queued').length;
        const running = [...tasks.values()].filter((t) => t.status === 'running').length;
        return send(res, 200, {
          ok: true, outDir: OUT_DIR, bridgeRev: BRIDGE_REV, pid: process.pid,
          extension: { connected: alive, tabReady: alive && ext.tabReady, url: ext.url, version: ext.version,
            // экземпляр, чей пульс принят последним, и ведущий (получает задачи); нужны при нескольких профилях Chrome
            inst: ext.inst || '', leader: leader ? { inst: leader.inst, secAgo: Math.round((now() - leader.at) / 1000) } : null,
            ...instancesBlock(),
            license: ext.license,   // 'expired' → задачи стоят, пользователю нужен ключ lingoflow.pro/omniflow
            // режиссёрский плейбук от расширения; пусто — расширение старое или не подключено
            director: alive ? brief.text : '', directorDigest: alive ? brief.digest : '',
            lastSeenSecAgo: ext.seenAt ? Math.round((now() - ext.seenAt) / 1000) : null,
            // почему задачи стоят: throttled — Flow троттлит, panel — идёт ручной пакет,
            // busy — расширение уже занято задачей моста. Пусто — берёт задачи.
            idle: ext.idle || '', pausedForSec: ext.pausedUntil > now() ? Math.round((ext.pausedUntil - now()) / 1000) : 0,
            // Google Vids: отдельная вкладка и отдельный месячный пул секунд (не кредиты Flow)
            vids: {
              connected: now() - vids.seenAt < EXT_STALE_MS, tabReady: now() - vids.seenAt < EXT_STALE_MS && vids.tabReady,
              url: vids.url, quota: vids.quota, build: vids.build || '', progress: vids.progress || '', diag: vidsDiag,
              queued: [...tasks.values()].filter((t) => targetOf(t) === 'vids' && t.status === 'queued').length,
            } },
          queue: { queued, running, jobs: jobs.size },
          // Финальный монтаж: стоит ли Tesseract, спрашивать ли человека, как идёт установка
          postproduction: await Tess.healthBlock(jobs, tasks),
          // ЧТО ДЕЛАЕТ CLAUDE ПРЯМО СЕЙЧАС — панель показывает это живьём, чтобы человек
          // видел работу агента, а не молчащий интерфейс.
          now: currentWork(),
        });
      }

      // ── новый мост просит уступить порт: только если мы старше и очередь пуста ──
      if (req.method === 'POST' && route === '/handover') {
        const bb = await readBody(req);
        const busy = [...tasks.values()].some((t) => t.status === 'queued' || t.status === 'running');
        if (!(Number(bb.rev) > BRIDGE_REV) || busy) return send(res, 200, { ok: false, rev: BRIDGE_REV, busy });
        log(`уступаю порт мосту ревизии ${bb.rev}`);
        send(res, 200, { ok: true, rev: BRIDGE_REV });
        setTimeout(() => { if (server) server.close(); server = null; }, 200);
        return;
      }

      // ── расширение отмечается (и заодно сообщает, открыт ли проект Flow) ──
      if (req.method === 'POST' && route === '/hello') {
        const b = await readBody(req);
        const inst = String(b.inst || '').slice(0, 16);
        const license = String(b.license || 'unknown').slice(0, 20);
        const version = String(b.version || '');
        instances.set(inst || `legacy-${version}`, { inst, version, license, tabReady: !!b.tabReady,
          tabVisible: b.tabVisible === true, url: String(b.url || '').slice(0, 200), at: now() });
        // Несколько экземпляров расширения (профили Chrome): ведущий — тот, кто последним показал
        // готовую вкладку проекта. Остальные пульс шлют, но задач не получают (см. /next).
        // Копия без ключа ведущей не становится: задачи она не берёт, и очередь стояла бы.
        // Ведущая роль ЛИПКАЯ: её продлевает только сам ведущий, другой копии она достаётся, лишь
        // когда ведущий 90 с не показывал готовую вкладку. 29.09 (SeedFlow): две готовые вкладки в
        // разных профилях перехватывали роль на каждом пульсе — сцены одного задания разлетались
        // по двум аккаунтам с разным балансом.
        // 11.10: ведущим оставался профиль, чьё окно человек не видит (проект открыт там, а на
        // экране — другой профиль): скрытая вкладка Flow/Vids не рисует интерфейс, и все сцены
        // падали. Копия с ВИДИМОЙ готовой вкладкой забирает роль у скрытого ведущего.
        const leadInfo = leader ? instances.get(leader.inst) : null;
        const hiddenLeader = !!(leader && leader.inst !== inst && leadInfo && leadInfo.tabVisible === false && b.tabVisible === true);
        if (inst && b.tabReady && license !== 'expired' && /\/project\//.test(String(b.url || ''))
          && (!leader || leader.inst === inst || hiddenLeader || now() - leader.at > LEADER_TTL_MS)) leader = { inst, at: now() };
        // Статус пишет только копия, которая может работать: старый код без id (≤1.94.5) и копии
        // с истёкшим ключом — слушатели, пока жива хоть одна новая копия с ключом.
        const workingAlive = [...instances.entries()].some(([k, i]) => k !== (inst || `legacy-${version}`)
          && i.inst && i.license !== 'expired' && now() - i.at < INST_SEEN_MS);
        const weak = !inst || license === 'expired';
        // экземпляр без id — старый код (≤1.94.5): при живом ведущем он тоже только слушатель
        const isLeader = !(weak && workingAlive) && (!leader || leader.inst === inst || now() - leader.at > LEADER_TTL_MS);
        if (!isLeader) { ext.seenAt = now(); return send(res, 200, { ok: true, needBrief: false, reload: reloadWanted, reloadAt, follower: true }); }
        ext = { seenAt: now(), tabReady: !!b.tabReady, url: String(b.url || '').slice(0, 200), version: String(b.version || ''), inst,
          license,
          // почему расширение сейчас не берёт задачи: пусто = берёт
          idle: String(b.idle || '').slice(0, 20), pausedUntil: Number(b.pausedUntil) || 0 };
        // плейбук просим заново, если его ещё нет или расширение обновилось
        const needBrief = !brief.text || brief.version !== ext.version;
        // Команда перезагрузки (dev). Экземпляров расширения может быть несколько (профили Chrome),
        // разовый флаг перехватывал первый попавшийся — поэтому отдаём ВРЕМЯ команды: каждый
        // экземпляр, запущенный раньше него, перезагружается ровно один раз.
        const reload = reloadWanted; reloadWanted = false;
        // Забор готовых клипов из галереи по просьбе Claude (POST /grab): расширение видит
        // просьбу в пульсе, жмёт «Скачать» на последних клипах и отчитывается в /grab-result.
        // pending — сколько задач Flow ждёт: при >0 расширение само возвращает вкладку в галерею
        // проекта (или открывает Flow), человеку не нужно искать нужную страницу
        const pending = [...tasks.values()].filter((t) => t.status === 'queued' && t.target !== 'vids').length;
        return send(res, 200, { ok: true, needBrief, reload, reloadAt, grab: grab.req, pending });
      }
      // ── забрать готовые клипы из проекта Flow без пересъёмки ──
      if (req.method === 'POST' && route === '/grab') {
        const b = await readBody(req);
        grab.req = { id: 'grab_' + randomUUID().slice(0, 8), limit: Math.max(1, Math.min(12, Number(b.limit) || 4)), name: String(b.name || 'из Flow').slice(0, 40), folder: String(b.folder || '').slice(0, 60), hint: String(b.hint || '').slice(0, 80), at: now() };
        grab.res = null;
        return send(res, 200, { ok: true, grabId: grab.req.id });
      }
      if (req.method === 'POST' && route === '/grab-result') {
        const b = await readBody(req);
        if (grab.req && b.id === grab.req.id) { grab.res = { ok: !!b.ok, files: Array.isArray(b.files) ? b.files : [], reason: b.reason ? String(b.reason).slice(0, 300) : null, at: now() }; grab.req = null; }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && route === '/grab') return send(res, 200, { pending: grab.req, result: grab.res });

      // ── ход задачи Vids: что сейчас на странице (видно в /health → extension.vids.progress) ──
      // ── dev: кадр вкладки Vids от адаптера (отладка) → omniflow-out/_shots ──
      if (req.method === 'POST' && route === '/vids/shot') {
        const b = await readBody(req);
        const m = /^data:image\/(png|jpeg);base64,(.*)$/s.exec(String(b.dataUrl || ''));
        if (!m) return send(res, 400, { error: 'no image' });
        const dir = path.join(OUT_DIR, '_shots'); fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'vids-' + Date.now() + (b.tag ? '-' + String(b.tag).replace(/[^a-z0-9-]/gi, '_').slice(0, 40) : '') + (m[1] === 'png' ? '.png' : '.jpg'));
        fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
        log('кадр Vids: ' + file);
        return send(res, 200, { ok: true, file });
      }
      if (req.method === 'POST' && route === '/vids/probe') {
        const b = await readBody(req);
        const dir = path.join(OUT_DIR, '_shots'); fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'probe-' + Date.now() + '.txt');
        fs.writeFileSync(file, String(b.text || '').slice(0, 200_000), 'utf8');
        log('осмотр Vids: ' + file);
        return send(res, 200, { ok: true, file });
      }
      if (req.method === 'POST' && route === '/vids/progress') {
        const b = await readBody(req);
        const t = tasks.get(String(b.id || ''));
        if (t) { t.updatedAt = now(); t.note = String(b.progress || '').slice(0, 200); }
        vids.progress = String(b.progress || '').slice(0, 200);
        if (b.diag) vidsDiag = String(b.diag).slice(0, 4000);
        vids.seenAt = now();
        return send(res, 200, { ok: true });
      }

      // ── dev: перезагрузить распакованное расширение со следующим пульсом ──
      if (req.method === 'POST' && route === '/dev/reload') {
        reloadWanted = true;
        reloadAt = now();
        return send(res, 200, { ok: true, reloadAt, note: 'расширение перезагрузится со следующим /hello (только распакованная установка)' });
      }

      // ── пульс вкладки Google Vids: готова ли, сколько секунд осталось в пуле ──
      if (req.method === 'POST' && route === '/vids/hello') {
        const b = await readBody(req);
        const q = b.quota && typeof b.quota === 'object' ? b.quota : null;
        // Пульс шлют все профили Chrome; тот, где вкладки Vids нет, не должен затирать живой статус
        // того, где она есть (иначе tabReady мигал true/false каждые 5 секунд).
        const fresh = now() - vids.seenAt < EXT_STALE_MS;
        if (b.url || !fresh || !vids.url) {
          vids = { seenAt: now(), tabReady: !!b.tabReady, url: String(b.url || '').slice(0, 200), build: String(b.build || '').slice(0, 40),
            quota: q ? { limit: Number(q.limit) || 0, remaining: Number(q.remaining) || 0, unit: String(q.unit || ''),
              resetAt: q.resetAt ? new Date(Number(q.resetAt)).toISOString() : null } : vids.quota };
        }
        const pending = [...tasks.values()].filter((t) => targetOf(t) === 'vids' && t.status === 'queued').length;
        return send(res, 200, { ok: true, pending });
      }

      // ── расширение отдаёт режиссёрский плейбук (свод правил остаётся в расширении) ──
      if (req.method === 'POST' && route === '/brief') {
        const b = await readBody(req);
        brief = { text: String(b.brief || '').slice(0, BRIEF_MAX), digest: String(b.digest || '').slice(0, 32),
          version: String(b.version || '').slice(0, 20) };
        return send(res, 200, { ok: true, chars: brief.text.length });
      }

      // ── финальный монтаж (Tesseract): статус, ответ человека, установка ──
      {
        const pp = await Tess.handleRoute(req, route, readBody, jobs, tasks);
        if (pp) return send(res, 200, pp);
      }

      // ── постановка задания ──
      if (req.method === 'POST' && route === '/jobs') {
        const b = await readBody(req);
        const items = Array.isArray(b.items) ? b.items : [];
        if (!items.length) return send(res, 400, { error: 'items is empty' });
        if (items.length > 40) return send(res, 400, { error: 'no more than 40 items per job' });
        const opts = b.opts && typeof b.opts === 'object' ? b.opts : {};
        const jobId = 'job_' + randomUUID().slice(0, 8);
        const dir = path.join(OUT_DIR, (opts.folder ? String(opts.folder).replace(/[^\p{L}\p{N} _-]+/gu, '') + ' ' : '') + jobId);
        fs.mkdirSync(dir, { recursive: true });
        const ids = [];
        let seq = 0;
        for (const raw of items) {
          const t = normalizeItem(raw, opts);
          t.seq = ++seq;
          t.chainFirst = t.seq === 1;   // первый элемент не наследует кадр от прошлых заданий
          t.jobId = jobId;
          t.prefix = opts.prefix ? String(opts.prefix) : '';
          tasks.set(t.id, t);
          ids.push(t.id);
        }
        const montage = opts.montage && typeof opts.montage === 'object' ? opts.montage : null;
        jobs.set(jobId, { id: jobId, createdAt: now(), items: ids, dir, montage, qa: !!opts.qa });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
          jobId, createdAt: new Date(now()).toISOString(), opts,
          items: ids.map((id) => { const t = tasks.get(id); return { seq: t.seq, prompt: t.prompt, mode: t.mode, model: t.model, aspect: t.aspect, length: t.length, hasFrames: !!t.frames }; }),
        }, null, 2), 'utf8');
        log(`job ${jobId}: ${ids.length} item(s) → ${dir}`);
        return send(res, 200, { ok: true, jobId, count: ids.length, dir });
      }

      // ── расширение забирает задачи ──
      if (req.method === 'GET' && route === '/next') {
        { const inst = String(url.searchParams.get('inst') || '').slice(0, 16);
          if (leader && leader.inst !== inst && now() - leader.at <= LEADER_TTL_MS) return send(res, 200, { tasks: [], follower: true });
          // старый код без id не забирает задачи, пока жива новая копия (она их выполнит лучше)
          if (!inst && [...instances.values()].some((i) => i.inst && i.license !== 'expired' && now() - i.at < INST_SEEN_MS)) {
            return send(res, 200, { tasks: [], follower: true });
          } }
        ext.seenAt = now();
        const limit = Math.max(1, Math.min(4, Number(url.searchParams.get('limit') || 1)));
        const target = url.searchParams.get('target') === 'vids' ? 'vids' : 'flow';
        if (target === 'vids') vids.seenAt = now();
        const picked = claimable(limit, target);
        for (const t of picked) { t.status = 'running'; t.updatedAt = now(); t.startedAt = t.startedAt || now(); }
        return send(res, 200, {
          tasks: picked.map((t) => ({
            id: t.id, prompt: t.prompt, mode: t.mode, model: t.model, aspect: t.aspect,
            length: t.length, count: t.count, resolution: t.resolution,
            frames: t.frames, characters: t.characters,
            // Эти пять полей мост принимал, но расширению не отдавал: flow_edit снимал
            // новый клип вместо правки, сшивка молча не работала, ассеты игнорировались.
            edit: !!t.edit, chain: !!t.chain, chainFirst: !!t.chainFirst,
            flowAssets: t.flowAssets || [], useMention: !!t.useMention,
            // Vids: режим и картинки — без них правка/анимация молча ушли бы как «создать»
            ...(targetOf(t) === 'vids' ? { vidsMode: t.vidsMode || 'create', images: t.images || [], script: t.script || '', avatar: t.avatar || '', debugShots: !!t.debugShots, panel: t.panel || '', clicks: t.clicks || [], format: t.format || '' } : {}),
          })),
        });
      }

      // ── расширение рапортует результат ──
      if (req.method === 'POST' && route === '/result') {
        const b = await readBody(req);
        const t = tasks.get(String(b.id || ''));
        if (!t) return send(res, 404, { error: 'no such task' });
        t.updatedAt = now();
        t.finishedAt = now();          // нужен панели, чтобы показать «последняя работа»
        t.note = b.note ? String(b.note).slice(0, 200) : null;
        if (b.timeout) t.timedOut = true;   // частичный результат — не выдаём за полный
        if (b.ok) {
          const j = jobs.get(t.jobId);
          t.files = b.grabbed
            ? adoptGrabbed(t, b.files, j ? j.dir : OUT_DIR, t.prefix)
            : writeResults(t, b.results, j ? j.dir : OUT_DIR, t.prefix);
          // «Готово» — это ФАЙЛ НА ДИСКЕ. Одна ссылка на CDN Flow результатом не является:
          // по ней ни Claude, ни человек ничего не откроют, а задача выглядела бы снятой.
          const onDisk = t.files.filter((f) => f && f.file).length;
          t.status = onDisk ? 'done' : 'failed';
          if (!onDisk) {
            t.error = t.files.length
              ? 'клип снят, но файла нет — Flow отдал только ссылку; заберите клип в галерее проекта'
              : 'расширение вернуло пустой результат';
          }
          log(`✓ ${t.seq}/${jobs.get(t.jobId)?.items.length}: ${t.files.map((f) => path.basename(f.file || f.url || '')).join(', ')}`);
        } else {
          t.status = 'failed';
          t.error = String(b.error || 'без причины').slice(0, 800);
          log(`✕ ${t.seq}: ${t.error}`);
        }
        if (t.jobId) Tess.writeMontage(jobs.get(t.jobId), tasks);   // последний клип задания → montage.json
        return send(res, 200, { ok: true });
      }

      // ── пересъёмка сцены после автопроверки ──
      if (req.method === 'POST' && /^\/jobs\/[^/]+\/redo$/.test(route)) {
        const b = await readBody(req);
        try {
          const r = redoScene(route.split('/')[2], Number(b.seq), b.prompt, !!b.force);
          return send(res, 200, { ok: true, ...r });
        } catch (e) { return send(res, 400, { error: (e && e.message) || String(e) }); }
      }

      // ── статус задания ──
      if (req.method === 'GET' && /^\/jobs\/[^/]+$/.test(route)) {
        const v = jobView(route.split('/')[2]);
        return v ? send(res, 200, v) : send(res, 404, { error: 'no such job' });
      }
      if (req.method === 'GET' && route === '/jobs') {
        return send(res, 200, { jobs: [...jobs.keys()].map(jobView) });
      }

      // ── отмена: чистим всё, что ещё не ушло в работу ──
      if (req.method === 'POST' && route === '/cancel') {
        let n = 0;
        for (const t of tasks.values()) if (t.status === 'queued') { t.status = 'failed'; t.error = 'отменено'; n++; }
        return send(res, 200, { ok: true, cancelled: n });
      }

      return send(res, 404, { error: 'no such route' });
    } catch (e) {
      return send(res, 400, { error: String((e && e.message) || e) });
    }
  });
}

/** Что за мост уже сидит на порту: ревизия (0 — старый без bridgeRev) и pid. */
async function occupantInfo(host, port) {
  try {
    const r = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return { rev: Number(j.bridgeRev) || 0, pid: j.pid || 0 };
  } catch { return { rev: 0, pid: 0 }; }
}

/** Поднять мост. Возвращает {port, close()}; порт уже занят — старый мост просим уступить, иначе работаем через занявший. */
export function startBridge(port = DEFAULT_PORT, host = HOST) {
  return new Promise((resolve, reject) => {
    ensureOutDir();
    const srv = createServer();
    let tries = 0;
    srv.on('error', async (e) => {
      if (!(e && e.code === 'EADDRINUSE')) return reject(e);
      // Порт занят. Если там мост старее нашего — просим уступить (пустая очередь), иначе
      // работаем через него. Мост без /health.bridgeRev (npm 1.1.2) уступить не умеет:
      // тогда сообщаем в статусе, что он устарел (occupant.outdated).
      const occ = await occupantInfo(host, port);
      if (occ.rev < BRIDGE_REV && tries < 2) {
        tries++;
        const ok = await fetch(`http://${host}:${port}/handover`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rev: BRIDGE_REV }) }).then((r) => r.json()).then((j) => j && j.ok).catch(() => false);
        if (ok) { await new Promise((r) => setTimeout(r, 600)); srv.listen(port, host); return; }
      }
      resolve({ port, host, already: true, occupant: { rev: occ.rev, pid: occ.pid, outdated: occ.rev < BRIDGE_REV }, close: () => {} });
    });
    srv.listen(port, host, () => {
      server = srv;
      log(`listening on http://${host}:${port} · results → ${OUT_DIR}`);
      if (isLoopback(host)) log('bound to loopback — no token required');
      else log(`EXTERNAL bind — the extension needs this token: ${TOKEN}`);
      resolve({ port, host, already: false, close: () => srv.close() });
    });
  });
}

// Прямой запуск: `node bridge/server.mjs` — мост без MCP (ручной режим, отладка, curl).
if (process.argv[1]?.replace(/\\/g, '/').endsWith('bridge/server.mjs')) {
  startBridge().catch((e) => { log('failed to start:', e.message); process.exit(1); });
}
