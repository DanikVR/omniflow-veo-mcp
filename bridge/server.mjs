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

export const DEFAULT_PORT = Number(process.env.OF_PORT || 8787);
export const HOST = process.env.OF_HOST || '127.0.0.1';
const OUT_DIR = path.resolve(process.env.OF_OUT || path.join(process.cwd(), 'omniflow-out'));
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
// Плейбук режиссёра приходит от расширения (POST /brief): мост открыт, свод правил — нет.
let brief = { text: '', digest: '', version: '' };
const BRIEF_MAX = 32_000;

const now = () => Date.now();
const log = (...a) => console.error('[omniflow]', ...a);   // stderr: stdout занят MCP-протоколом

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
  if (!prompt) throw new Error('у элемента нет prompt');
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
    frames: null,
    characters: [],
    files: [],
    error: null,
  };
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
    folder: job && job.dir ? String(job.dir).split(/[\/]/).pop() : null,
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
function claimable(limit) {
  const out = [];
  for (const t of tasks.values()) {
    if (out.length >= limit) break;
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
    const kind = r && r.kind === 'image' ? 'image' : 'video';
    const dataUrl = r && r.dataUrl;
    if (!dataUrl || !/^data:/.test(dataUrl)) {
      // http(s)-ссылка без байтов: сохраняем как ссылку — качать CDN Flow можно только из вкладки
      saved.push({ kind, url: (r && r.sourceUrl) || null, file: null });
      continue;
    }
    const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
    const mime = m ? m[1] : (kind === 'image' ? 'image/jpeg' : 'video/mp4');
    const ext2 = /png/.test(mime) ? '.png' : /webp/.test(mime) ? '.webp' : /jpe?g/.test(mime) ? '.jpg'
      : /webm/.test(mime) ? '.webm' : kind === 'image' ? '.jpg' : '.mp4';
    const safe = String(task.prompt).replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 48) || 'clip';
    const base = `${prefix ? prefix + ' ' : ''}${String(task.seq || 0).padStart(2, '0')} ${safe}${n > 1 ? ' (' + n + ')' : ''}${ext2}`;
    const file = path.join(jobDir, base);
    fs.writeFileSync(file, Buffer.from(m ? m[2] : '', 'base64'));
    saved.push({ kind, file, url: (r && r.sourceUrl) || null });
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
    } : null;
  }).filter(Boolean);
  const done = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'failed').length;
  return {
    jobId, dir: j.dir, total: items.length, done, failed,
    finished: done + failed >= items.length,
    items,
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
      // ── статус: жив ли мост, видит ли расширение вкладку Flow ──
      if (req.method === 'GET' && route === '/health') {
        const alive = now() - ext.seenAt < EXT_STALE_MS;
        const queued = [...tasks.values()].filter((t) => t.status === 'queued').length;
        const running = [...tasks.values()].filter((t) => t.status === 'running').length;
        return send(res, 200, {
          ok: true, outDir: OUT_DIR,
          extension: { connected: alive, tabReady: alive && ext.tabReady, url: ext.url, version: ext.version,
            license: ext.license,   // 'expired' → задачи стоят, пользователю нужен ключ lingoflow.pro/omniflow
            // режиссёрский плейбук от расширения; пусто — расширение старое или не подключено
            director: alive ? brief.text : '', directorDigest: alive ? brief.digest : '',
            lastSeenSecAgo: ext.seenAt ? Math.round((now() - ext.seenAt) / 1000) : null,
            // почему задачи стоят: throttled — Flow троттлит, panel — идёт ручной пакет,
            // busy — расширение уже занято задачей моста. Пусто — берёт задачи.
            idle: ext.idle || '', pausedForSec: ext.pausedUntil > now() ? Math.round((ext.pausedUntil - now()) / 1000) : 0 },
          queue: { queued, running, jobs: jobs.size },
          // ЧТО ДЕЛАЕТ CLAUDE ПРЯМО СЕЙЧАС — панель показывает это живьём, чтобы человек
          // видел работу агента, а не молчащий интерфейс.
          now: currentWork(),
        });
      }

      // ── расширение отмечается (и заодно сообщает, открыт ли проект Flow) ──
      if (req.method === 'POST' && route === '/hello') {
        const b = await readBody(req);
        ext = { seenAt: now(), tabReady: !!b.tabReady, url: String(b.url || '').slice(0, 200), version: String(b.version || ''),
          license: String(b.license || 'unknown').slice(0, 20),
          // почему расширение сейчас не берёт задачи: пусто = берёт
          idle: String(b.idle || '').slice(0, 20), pausedUntil: Number(b.pausedUntil) || 0 };
        // плейбук просим заново, если его ещё нет или расширение обновилось
        const needBrief = !brief.text || brief.version !== ext.version;
        return send(res, 200, { ok: true, needBrief });
      }

      // ── расширение отдаёт режиссёрский плейбук (свод правил остаётся в расширении) ──
      if (req.method === 'POST' && route === '/brief') {
        const b = await readBody(req);
        brief = { text: String(b.brief || '').slice(0, BRIEF_MAX), digest: String(b.digest || '').slice(0, 32),
          version: String(b.version || '').slice(0, 20) };
        return send(res, 200, { ok: true, chars: brief.text.length });
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
        jobs.set(jobId, { id: jobId, createdAt: now(), items: ids, dir });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
          jobId, createdAt: new Date(now()).toISOString(), opts,
          items: ids.map((id) => { const t = tasks.get(id); return { seq: t.seq, prompt: t.prompt, mode: t.mode, model: t.model, aspect: t.aspect, length: t.length, hasFrames: !!t.frames }; }),
        }, null, 2), 'utf8');
        log(`задание ${jobId}: ${ids.length} шт → ${dir}`);
        return send(res, 200, { ok: true, jobId, count: ids.length, dir });
      }

      // ── расширение забирает задачи ──
      if (req.method === 'GET' && route === '/next') {
        ext.seenAt = now();
        const limit = Math.max(1, Math.min(4, Number(url.searchParams.get('limit') || 1)));
        const picked = claimable(limit);
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
          t.files = writeResults(t, b.results, j ? j.dir : OUT_DIR, t.prefix);
          t.status = t.files.length ? 'done' : 'failed';
          if (!t.files.length) t.error = 'расширение вернуло пустой результат';
          log(`✓ ${t.seq}/${jobs.get(t.jobId)?.items.length}: ${t.files.map((f) => path.basename(f.file || f.url || '')).join(', ')}`);
        } else {
          t.status = 'failed';
          t.error = String(b.error || 'без причины').slice(0, 300);
          log(`✕ ${t.seq}: ${t.error}`);
        }
        return send(res, 200, { ok: true });
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

/** Поднять мост. Возвращает {port, close()}; порт уже занят — считаем, что мост уже поднят. */
export function startBridge(port = DEFAULT_PORT, host = HOST) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const srv = createServer();
    srv.once('error', (e) => (e && e.code === 'EADDRINUSE' ? resolve({ port, host, already: true, close: () => {} }) : reject(e)));
    srv.listen(port, host, () => {
      log(`слушаю http://${host}:${port} · результаты → ${OUT_DIR}`);
      if (isLoopback(host)) log('привязка локальная — токен не требуется');
      else log(`ВНЕШНЯЯ привязка — расширению нужен токен: ${TOKEN}`);
      resolve({ port, host, already: false, close: () => srv.close() });
    });
  });
}

// Прямой запуск: `node bridge/server.mjs` — мост без MCP (ручной режим, отладка, curl).
if (process.argv[1]?.replace(/\\/g, '/').endsWith('bridge/server.mjs')) {
  startBridge().catch((e) => { log('не поднялся:', e.message); process.exit(1); });
}
