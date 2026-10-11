/**
 * Tesseract (Mirage) — финальный монтаж клипов: титры, музыка, логотип, субтитры.
 *
 * ПОЧЕМУ НЕ В ПАКЕТЕ. Лицензия Mirage (TERMS § 2.2.2) запрещает распространять программу.
 * Поэтому мост ничего не раздаёт сам: с согласия человека он скачивает архив прямо
 * со страницы релизов Mirage на GitHub, сверяет sha256 с суммой, зашитой ниже, и запускает
 * их же установщик.
 *
 * ПОЧЕМУ ВЕРСИЯ ЗАШИТА. Tesseract 0.x: формат проекта и команды меняются. Скиллы Mirage
 * сами требуют точную версию (cli-version.txt), поэтому «брать самую свежую» нельзя.
 * Новая версия приезжает к людям только после нашей проверки: поднимаем PIN — мост у
 * согласившихся обновляет Tesseract сам, без вопросов.
 *
 * Согласие хранится в ~/.lingoflow-tesseract.json — общее для OmniFlow, SeedFlow и SymFlow:
 * согласился в одном продукте — второй раз не спрашиваем.
 *
 * ОДИН ФАЙЛ НА ТРИ МОСТА. Источник — omniflow/bridge/tesseract.mjs; seedflow/bridge и
 * symflow/bridge держат его точную копию (test/tesseract.test.mjs сверяет байты). Правка —
 * здесь, потом копия в два других моста.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import zlib from 'node:zlib';

/** Проверенная нами версия. Суммы — из release-manifest.json релиза v0.2.0. */
export const PIN = {
  version: '0.2.0',
  base: 'https://github.com/mirage-hq/Tesseract/releases/download/v0.2.0/',
  skills: { file: 'tesseract.zip', sha256: 'dadea3c45bad8afbc1f61b65db8ee6ab4a9a3666582a8f3e4b521f9c484d619f' },
  cli: {
    'windows-x86_64': { file: 'tesseract-0.2.0-windows-x86_64.zip', sha256: '35822d306209476d5c80ac3fafed6be6110afd70840f6c7179e5a35caf57b988', mb: 109 },
    'darwin-arm64': { file: 'tesseract-0.2.0-darwin-arm64.zip', sha256: 'c5a0ab2d7840a3bfee60270d8f9b365f4e5ce8833142bbf9a42beea3d5419ca0', mb: 85 },
    'darwin-x86_64': { file: 'tesseract-0.2.0-darwin-x86_64.zip', sha256: '15d33a41a90d62d5bcaffcab0410c732fbd77ee029a8d31e2541012e27a46a8b', mb: 88 },
    'linux-x86_64': { file: 'tesseract-0.2.0-linux-x86_64.zip', sha256: '7ba15a9ff68a4a999fa965df702c304ba5b0efbba7d974782c893a21afec572f', mb: 87 },
  },
};
export const TERMS_URL = 'https://mirage.app/legal/tesseract-terms';
export const HOME_URL = 'https://github.com/mirage-hq/Tesseract';
const SKILL_NAMES = ['tesseract-video', 'tesseract-motion'];
const CONSENT_FILE = path.join(os.homedir(), '.lingoflow-tesseract.json');
const log = (...a) => console.error('[tesseract]', ...a);

/** Платформа в терминах релизов Mirage; '' — не поддерживается. */
export function platformKey(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'x64' ? 'windows-x86_64' : '';
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : arch === 'x64' ? 'darwin-x86_64' : '';
  if (platform === 'linux') return arch === 'x64' ? 'linux-x86_64' : '';
  return '';
}

/** Куда ставит установщик Mirage (installation.md). */
export function cliPath(platform = process.platform) {
  const home = os.homedir();
  if (platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Tesseract', 'bin', 'tsrct.cmd');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Tesseract', 'bin', 'tsrct');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'Tesseract', 'bin', 'tsrct');
}
const skillsDir = () => path.join(os.homedir(), '.claude', 'skills');

/** '0.2.0' < '0.10.0' — сравнение по числам, не по строке. */
export function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: opts.timeout || 60_000, maxBuffer: 8 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? err.code : 0, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
}
/** tsrct.cmd на Windows запускается только через cmd.exe. */
function runCli(exe, args, opts) {
  if (process.platform === 'win32') return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${exe}" ${args.join(' ')}`], { ...opts, windowsVerbatimArguments: true });
  return run(exe, args, opts);
}

// ── согласие ──────────────────────────────────────────────────────────────────
/** decision: null — ещё не спрашивали; 'yes'; 'no'. askAgain — снятая галочка «больше не спрашивать». */
export function readConsent() {
  try {
    const c = JSON.parse(fs.readFileSync(CONSENT_FILE, 'utf8'));
    return { decision: c.decision === 'yes' || c.decision === 'no' ? c.decision : null,
      askAgain: c.askAgain !== false, declinedJob: c.declinedJob || null, at: c.at || null };
  } catch { return { decision: null, askAgain: true, declinedJob: null, at: null }; }
}
function writeConsent(c) {
  try { fs.writeFileSync(CONSENT_FILE, JSON.stringify({ ...c, at: new Date().toISOString() }, null, 2), 'utf8'); }
  catch (e) { log('согласие не сохранилось:', e.message); }
}

/**
 * Спрашивать ли сейчас. Установлен — никогда. «Нет» с галочкой «больше не спрашивать» —
 * никогда. Просто «Нет» — снова, но только на СЛЕДУЮЩЕМ готовом задании, не на том же.
 */
export function shouldAsk({ installed, consent, lastDoneJob }) {
  if (installed) return false;
  if (!lastDoneJob) return false;                    // клипов ещё нет — монтировать нечего
  if (consent.decision === 'yes') return false;      // согласие есть, ставится или поставится само
  if (consent.decision === 'no') return consent.askAgain && consent.declinedJob !== lastDoneJob;
  return true;
}

// ── обнаружение ───────────────────────────────────────────────────────────────
let cache = { at: 0, v: null };
export async function detect(force = false) {
  if (!force && cache.v && Date.now() - cache.at < 60_000) return cache.v;
  const exe = cliPath();
  let version = null;
  if (fs.existsSync(exe)) {
    const r = await runCli(exe, ['--version'], { timeout: 20_000 });
    const m = /(\d+\.\d+\.\d+)/.exec(r.out + ' ' + r.err);
    version = m ? m[1] : null;
  }
  const skills = SKILL_NAMES.every((s) => fs.existsSync(path.join(skillsDir(), s, 'SKILL.md')));
  let skillsVersion = null;
  try { skillsVersion = fs.readFileSync(path.join(skillsDir(), SKILL_NAMES[0], 'references', 'cli-version.txt'), 'utf8').trim(); } catch { /* нет скиллов */ }
  const v = { installed: !!version && skills, version, skills, skillsVersion, path: version ? exe : null };
  cache = { at: Date.now(), v };
  return v;
}

// ── установка ─────────────────────────────────────────────────────────────────
let job = { phase: 'idle', note: '', error: null, doneMB: 0, totalMB: 0, startedAt: 0, finishedAt: 0 };
export const installState = () => ({ ...job });

async function download(url, file, expectSha, totalMB, track = true) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`скачивание ${path.basename(file)}: HTTP ${r.status}`);
  const hash = createHash('sha256');
  const out = fs.createWriteStream(file);
  // прогресс в панели — только по большому архиву программы, скиллы весят меньше мегабайта
  if (track) job.totalMB = totalMB || Math.round(Number(r.headers.get('content-length') || 0) / 1048576);
  let bytes = 0;
  for await (const chunk of r.body) {
    hash.update(chunk);
    bytes += chunk.length;
    if (track) job.doneMB = Math.round(bytes / 1048576);
    if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
  }
  await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  const got = hash.digest('hex');
  // Не совпала сумма — файл подменён или битый: не ставим НИЧЕГО.
  if (got !== expectSha) { fs.rmSync(file, { force: true }); throw new Error(`контрольная сумма ${path.basename(file)} не совпала — установка остановлена`); }
}

async function unzip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const r = process.platform === 'win32'
    ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`], { timeout: 600_000 })
    : process.platform === 'darwin' ? await run('ditto', ['-x', '-k', zip, dest], { timeout: 600_000 })
      : await run('unzip', ['-q', '-o', zip, '-d', dest], { timeout: 600_000 });
  if (!r.ok) throw new Error('распаковка: ' + r.err.slice(0, 200));
}

/** Папка внутри распакованного архива, где лежит нужный файл (install.ps1 / skills). */
function findDir(root, name, depth = 4) {
  if (depth < 0) return null;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  if (entries.some((e) => e.name === name)) return root;
  for (const e of entries) if (e.isDirectory()) { const f = findDir(path.join(root, e.name), name, depth - 1); if (f) return f; }
  return null;
}

/** Скачать, сверить, поставить CLI и скиллы, выключить телеметрию. Повторный вызов во время работы — no-op. */
export function install({ reason = 'consent' } = {}) {
  if (job.phase !== 'idle' && job.phase !== 'done' && job.phase !== 'error') return installState();
  const key = platformKey();
  if (!key) { job = { ...job, phase: 'error', error: `Tesseract не поддерживает эту систему (${process.platform} ${process.arch})` }; return installState(); }
  job = { phase: 'downloading', note: reason, error: null, doneMB: 0, totalMB: PIN.cli[key].mb, startedAt: Date.now(), finishedAt: 0 };
  (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tesseract-'));
    try {
      const cli = PIN.cli[key];
      const cliZip = path.join(tmp, cli.file);
      log(`скачиваю ${cli.file} (~${cli.mb} МБ) с ${PIN.base}`);
      await download(PIN.base + cli.file, cliZip, cli.sha256, cli.mb);
      const skZip = path.join(tmp, PIN.skills.file);
      await download(PIN.base + PIN.skills.file, skZip, PIN.skills.sha256, 1, false);

      job.phase = 'installing';
      await unzip(cliZip, path.join(tmp, 'cli'));
      const installer = process.platform === 'win32' ? 'install.ps1' : 'install.sh';
      const dir = findDir(path.join(tmp, 'cli'), installer);
      if (!dir) throw new Error(`в архиве нет ${installer}`);
      const r = process.platform === 'win32'
        ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, installer)], { timeout: 600_000, cwd: dir })
        : await run('bash', [path.join(dir, installer)], { timeout: 600_000, cwd: dir });
      if (!r.ok) throw new Error('установщик Mirage: ' + (r.err || r.out).slice(-300));

      // Скиллы Claude: копия из их же архива, версия совпадает с CLI.
      job.phase = 'skills';
      await unzip(skZip, path.join(tmp, 'skills'));
      const skRoot = findDir(path.join(tmp, 'skills'), SKILL_NAMES[0]);
      if (!skRoot) throw new Error('в архиве скиллов нет tesseract-video');
      for (const s of SKILL_NAMES) {
        const to = path.join(skillsDir(), s);
        fs.rmSync(to, { recursive: true, force: true });
        fs.cpSync(path.join(skRoot, s), to, { recursive: true });
      }

      // Телеметрия у Mirage включена по умолчанию. Мы её выключаем и говорим об этом
      // человеку; включить обратно — `tsrct telemetry enable`.
      const exe = cliPath();
      await runCli(exe, ['telemetry', 'disable'], { timeout: 30_000 });
      const d = await detect(true);
      if (!d.version) throw new Error('после установки tsrct --version не отвечает');
      if (cmpVersion(d.version, PIN.version) !== 0) throw new Error(`установилась ${d.version}, ожидалась ${PIN.version}`);
      job = { ...job, phase: 'done', finishedAt: Date.now() };
      log(`Tesseract ${d.version} установлен → ${exe}`);
    } catch (e) {
      job = { ...job, phase: 'error', error: String((e && e.message) || e).slice(0, 400), finishedAt: Date.now() };
      log('установка не удалась:', job.error);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* временная папка — не критично */ }
    }
  })();
  return installState();
}

/** Ответ человека: yes — ставим сразу; no — запоминаем, askAgain решает, спросим ли потом. */
export function decide({ decision, askAgain = true, jobId = null }) {
  const c = readConsent();
  if (decision === 'yes') {
    writeConsent({ decision: 'yes', askAgain: true, declinedJob: null });
    return install({ reason: 'consent' });
  }
  writeConsent({ decision: 'no', askAgain: askAgain !== false, declinedJob: jobId || c.declinedJob || null });
  return installState();
}

/**
 * Контролируемое обновление: человек уже согласился, стоит старее PIN (или скиллы от
 * другой версии) — обновляем молча. Новее PIN не трогаем: значит, человек поставил сам.
 */
export async function maybeAutoUpdate() {
  const c = readConsent();
  if (c.decision !== 'yes' || (job.phase !== 'idle' && job.phase !== 'done')) return;
  if (job.phase === 'done' && Date.now() - job.finishedAt < 60_000) return;
  const d = await detect();
  const old = !d.version || cmpVersion(d.version, PIN.version) < 0;
  const skillsOld = !d.skills || (d.skillsVersion && cmpVersion(d.skillsVersion, PIN.version) < 0);
  if (old || skillsOld) { log(`обновляю Tesseract ${d.version || '—'} → ${PIN.version}`); install({ reason: 'update' }); }
}

/** Сводка для /health и flow_postprod. */
export async function summary({ lastDoneJob = null } = {}) {
  const d = await detect();
  const consent = readConsent();
  const key = platformKey();
  return {
    tesseract: { ...d, pinned: PIN.version, upToDate: !!d.version && cmpVersion(d.version, PIN.version) >= 0,
      supported: !!key, sizeMB: key ? PIN.cli[key].mb : null, terms: TERMS_URL, home: HOME_URL },
    consent,
    shouldAsk: !!key && shouldAsk({ installed: d.installed, consent, lastDoneJob }),
    lastDoneJob,
    install: installState(),
  };
}

// ── монтажные данные задания (общие для трёх мостов) ────────────────────────────
// Задачи у мостов устроены по-разному: OmniFlow/SeedFlow держат prompt/aspect/length в самой
// задаче, SymFlow — в params. Читаем из обоих мест.
const VIDEO_RE = /\.(mp4|m4v|mov|webm)$/i;
const pick = (t, k, ...alt) => {
  for (const key of [k, ...alt]) {
    if (t[key] != null && t[key] !== '') return t[key];
    if (t.params && t.params[key] != null && t.params[key] !== '') return t.params[key];
  }
  return null;
};
// SymFlow: дубляж — это языковые версии одного ролика, editor — уже смонтированный ролик,
// frame/download/upload — служебные задачи. Монтировать из них нечего.
const NOT_FOOTAGE = new Set(['editor', 'dub', 'frame', 'download', 'upload', 'wait']);
const REPLACES_PREV = new Set(['edit', 'extend', 'upscale']);
const clipOf = (t) => (t.files || []).find((f) => f && f.file && VIDEO_RE.test(String(f.file))) || null;

/** Длительность mp4/mov в секундах (атом mvhd) — монтажу нужна точная длина каждого клипа. */
export function videoDuration(p) {
  try {
    const buf = fs.readFileSync(path.resolve(p));
    const i = buf.indexOf('mvhd');
    if (i < 0) return null;
    const ver = buf[i + 4];
    const ts = ver === 1 ? buf.readUInt32BE(i + 4 + 4 + 16) : buf.readUInt32BE(i + 4 + 4 + 8);
    const dur = ver === 1 ? Number(buf.readBigUInt64BE(i + 4 + 4 + 20)) : buf.readUInt32BE(i + 4 + 4 + 12);
    return ts ? Math.round((dur / ts) * 1000) / 1000 : null;
  } catch { return null; }
}

/**
 * Последнее задание, из которого есть что монтировать: всё закончено, это не правка и не
 * сухой прогон, и готово хотя бы ДВА видеоклипа — один клип монтировать не во что.
 */
export function lastMontageJob(jobs, tasks) {
  let best = null;
  for (const j of jobs.values()) {
    const items = j.items.map((id) => tasks.get(id)).filter(Boolean);
    if (!items.length || items.some((t) => t.status === 'queued' || t.status === 'running')) continue;
    if (items.some((t) => t.edit || t.dryRun || NOT_FOOTAGE.has(t.tool))) continue;
    const done = items.filter((t) => t.status === 'done' && clipOf(t));
    if (done.filter((t) => !REPLACES_PREV.has(t.vidsMode)).length < 2) continue;   // сцен, а не файлов
    const fin = Math.max(...done.map((t) => t.finishedAt || 0));
    if (!best || fin > best.fin) best = { id: j.id, fin };
  }
  return best ? best.id : null;
}

/**
 * montage.json — всё, что нужно для финального монтажа, в одном файле рядом с клипами:
 * порядок сцен, точные длины, надписи и реплики из сценария, бренд и музыка. Без него
 * Claude угадывал бы, что есть что; с ним титры и субтитры берутся из сценария, а не
 * из распознавания речи (которого в Tesseract нет). Возвращает путь или null.
 */
export function writeMontage(job, tasks) {
  if (!job || !job.dir) return null;
  const items = job.items.map((id) => tasks.get(id)).filter(Boolean);
  if (items.some((t) => t.status !== 'done' && t.status !== 'failed')) return null;
  const clips = [];
  for (const t of items.sort((a, b) => a.seq - b.seq)) {
    const f = clipOf(t);
    if (t.status !== 'done' || !f) continue;
    const dur = videoDuration(f.file) || Number(pick(t, 'length', 'duration')) || null;
    const clip = { seq: t.seq, file: f.file, durationSec: dur,
      aspect: pick(t, 'aspect', 'ratio'), prompt: pick(t, 'prompt') || '',
      onScreen: pick(t, 'onScreen') || '', speech: pick(t, 'speech') || '' };
    // Google Vids: edit / extend / upscale не новая сцена, а новая версия ПРЕДЫДУЩЕГО клипа —
    // иначе в монтаж попали бы оба варианта (720p и 1080p, до и после правки).
    if (REPLACES_PREV.has(t.vidsMode) && clips.length) {
      const prev = clips[clips.length - 1];
      clips[clips.length - 1] = { ...clip, onScreen: clip.onScreen || prev.onScreen, speech: clip.speech || prev.speech,
        prompt: prev.prompt, replaces: prev.file };
      continue;
    }
    clips.push(clip);
  }
  let at = 0;
  for (const c of clips) { c.start = Math.round(at * 1000) / 1000; at += c.durationSec || 0; }
  if (!clips.length) return null;
  const warnings = [];
  for (const c of clips) {
    c.frame = analyzeClip(c.file);
    if (c.frame && c.frame.blank) {
      warnings.push(`clip ${c.seq}: flat ${c.frame.blank.pct}% band at the ${c.frame.blank.edge} edge — a generation defect, not montage. `
        + 'Reshoot it: describe the background behind the subject reaching that edge and add «single unified image, no split screen, no panels, no borders, no blank areas».');
    }
  }
  const m = job.montage || (job.opts && job.opts.montage) || {};
  const file = path.join(job.dir, 'montage.json');
  try {
    fs.writeFileSync(file, JSON.stringify({
      jobId: job.id, createdAt: new Date().toISOString(), aspect: clips[0].aspect, totalSec: Math.round(at * 1000) / 1000,
      clips,
      brand: { title: m.title || '', cta: m.cta || '', logo: m.logo || '', colors: Array.isArray(m.colors) ? m.colors : [] },
      music: m.music || '', languages: Array.isArray(m.languages) ? m.languages : [],
      titles: titleKit(job.dir, clips[0].aspect),
      warnings,
      editor: 'tesseract',
    }, null, 2), 'utf8');
    job.montageFile = file;
    return file;
  } catch (e) { log('montage.json не записан:', e.message); return null; }
}

/**
 * Кадр клипа глазами монтажёра: есть ли у края пустая заливка и где титру спокойнее.
 * 29.09 (ролик Longev): Omni на «clean negative space in the upper third» залил белым
 * 23–30 % кадра в трёх клипах из семи — заметили только в готовом ролике. Теперь монтаж
 * узнаёт об этом из montage.json до сборки. Нужен ffmpeg в PATH; без него — frame:null.
 */
export function analyzeClip(file, at = 1) {
  const W = 64;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
    '-vf', `scale=${W}:-2,format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20, timeout: 20_000 });
  if (r.error || r.status !== 0 || !r.stdout || r.stdout.length < W * 8) return null;
  const px = r.stdout, H = Math.floor(px.length / W);
  const row = (y) => { let s = 0, q = 0; for (let x = 0; x < W; x++) { const v = px[y * W + x]; s += v; q += v * v; }
    const m = s / W; return { m, sd: Math.sqrt(Math.max(0, q / W - m * m)) }; };
  const flatRun = (ys) => { let n = 0, ref = null;
    for (const y of ys) { const { m, sd } = row(y); if (sd > 4 || (m > 25 && m < 200)) break;
      if (ref === null) ref = m; else if (Math.abs(m - ref) > 6) break; n++; } return n; };
  const ys = [...Array(H).keys()];
  const top = flatRun(ys), bottom = flatRun(ys.slice().reverse());
  const zone = (y0, y1) => { let s = 0, q = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) { const v = px[y * W + x]; s += v; q += v * v; n++; }
    const m = s / n; return { luma: Math.round(m), busy: Math.round(Math.sqrt(Math.max(0, q / n - m * m))) }; };
  const third = Math.floor(H / 3);
  const zones = { top: zone(0, third), bottom: zone(H - third, H) };
  const pct = (n) => Math.round((n / H) * 100);
  const blank = pct(top) >= 8 ? { edge: 'top', pct: pct(top) } : pct(bottom) >= 8 ? { edge: 'bottom', pct: pct(bottom) } : null;
  // титр — сверху, если там нет заливки и фон не сильно пестрее низа
  const titleEdge = blank && blank.edge === 'top' ? 'bottom'
    : zones.top.busy > zones.bottom.busy * 1.6 ? 'bottom' : 'top';
  return { blank, zones, titleEdge, scrim: zones[titleEdge].luma > 100 };
}

/** PNG-градиент под титр: тёмный у края, прозрачный к середине. Без зависимостей. */
export function scrimPng(w, h, edge = 'top', { depth = 0.5, alpha = 0.62, rgb = [10, 12, 11] } = {}) {
  const span = Math.max(1, Math.round(h * depth)), stride = w * 4 + 1, raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const d = edge === 'top' ? y : h - 1 - y;
    const a = d < span ? Math.round(255 * alpha * Math.pow(1 - d / span, 1.6)) : 0;
    for (let x = 0; x < w; x++) { const o = y * stride + 1 + x * 4; raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; raw[o + 3] = a; }
  }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const CANVAS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080] };

/** Скримы и правила титров для montage.json: файлы кладутся рядом с клипами. */
function titleKit(dir, aspect) {
  const [w, h] = CANVAS[aspect] || CANVAS['9:16'];
  const out = {};
  for (const edge of ['top', 'bottom']) {
    const f = path.join(dir, `scrim-${edge}.png`);
    try { fs.writeFileSync(f, scrimPng(w, h, edge)); out[edge] = f; } catch { /* нет места — обойдёмся без скрима */ }
  }
  return {
    canvas: [w, h], scrim: out,
    advice: 'Put each title over the scrim of its clip.frame.titleEdge (full-canvas Image layer under the text, same activeRange and fade). '
      + 'Flat white text, no drop shadow; serif display at weight 700 (≈92 px on 1080 wide) or a bold sans; kicker line bold, tracked. '
      + 'Keep the title off faces: if the subject\'s head is in the title zone, move the title to the other edge.',
  };
}

/** Схема поля montage для инструментов генерации — одна на три моста. */
export const MONTAGE_SCHEMA = {
  type: 'object',
  description: 'Data for the final montage in Tesseract (saved to montage.json next to the clips)',
  properties: {
    title: { type: 'string', description: 'Opening title / hook text in the language the user writes in' },
    cta: { type: 'string', description: 'Final call to action in the language the user writes in' },
    logo: { type: 'string', description: 'Absolute path to the logo (PNG/SVG)' },
    colors: { type: 'array', items: { type: 'string' }, description: 'Brand colors, hex' },
    music: { type: 'string', description: 'Absolute path to the music track' },
    languages: { type: 'array', items: { type: 'string' }, description: 'Extra language versions of titles/subtitles, e.g. ["en","de"]' },
  },
};

/**
 * MCP-инструмент финального монтажа. name — flow_postprod / dream_postprod / sym_postprod,
 * status — инструмент статуса этого моста, api/sleep — его клиент моста.
 */
export function postprodTool({ name, status, api, sleep }) {
  return {
    name,
    description: `Final montage with Tesseract by Mirage (free local editor: titles in any language, music with ducking, logo end card, subtitles, language versions without new generations). action "status" — is it installed, \`shouldAsk\`, install progress. When ${status} → postproduction.shouldAsk is true after clips are ready, ask the user EXACTLY with three options: «Для более качественного монтажа требуется Tesseract от Mirage (бесплатно, ~110 МБ, условия: <terms>). Установить?» (in the user's language) → [Да, установить] → action "install" (waits until installed, up to 10 min); [Нет, спасибо] → action "decline"; [Нет и больше не спрашивать] → action "decline" with askAgain:false. If Tesseract is installed — never ask. The bridge downloads Tesseract from the official Mirage GitHub release, verifies sha256, turns Mirage telemetry off (tell the user) and installs the tesseract-video / tesseract-motion skills. Updates are controlled: the bridge updates Tesseract by itself to the version we tested — never install another version yourself.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'install', 'decline'] },
        askAgain: { type: 'boolean', description: 'For decline: false = the user ticked «больше не спрашивать»' },
      },
      required: ['action'],
    },
    handler: async (args) => {
      const post = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
      if (args.action === 'decline') return post('/postprod/consent', { decision: 'no', askAgain: args.askAgain !== false });
      if (args.action !== 'install') return api('/postprod');
      let st = await post('/postprod/install');
      const deadline = Date.now() + 10 * 60_000;
      while (['downloading', 'installing', 'skills'].includes(st.install && st.install.phase) && Date.now() < deadline) {
        await sleep(3000);
        st = await api('/postprod');
      }
      if (st.tesseract && st.tesseract.installed) {
        st.next = 'Installed. Mirage telemetry was turned off (tsrct telemetry enable turns it back on) — say so. Skills tesseract-video / tesseract-motion are in ~/.claude/skills: they load in a NEW Claude session; in this session read ~/.claude/skills/tesseract-video/SKILL.md directly and follow it. Build the montage from montage.json in the job folder: read montage.warnings first (reshoot clips with blank bands), put titles over montage.titles.scrim.';
      }
      return st;
    },
  };
}

/**
 * HTTP-маршруты монтажа для моста: /postprod, /postprod/consent, /postprod/install.
 * Возвращает объект-ответ или null, если маршрут не наш. readBody — читалка тела этого моста.
 */
export async function handleRoute(req, route, readBody, jobs, tasks) {
  const view = async () => {
    maybeAutoUpdate().catch(() => {});
    return summary({ lastDoneJob: lastMontageJob(jobs, tasks) });
  };
  if (req.method === 'GET' && route === '/postprod') return view();
  if (req.method === 'POST' && route === '/postprod/consent') {
    const b = await readBody(req);
    decide({ decision: b.decision === 'yes' ? 'yes' : 'no', askAgain: b.askAgain !== false,
      jobId: String(b.jobId || lastMontageJob(jobs, tasks) || '') || null });
    return { ok: true, ...(await view()) };
  }
  if (req.method === 'POST' && route === '/postprod/install') {
    decide({ decision: 'yes' });
    return { ok: true, ...(await view()) };
  }
  return null;
}

/** Блок postproduction для /health (ошибка здесь не должна ронять статус моста). */
export async function healthBlock(jobs, tasks) {
  try {
    maybeAutoUpdate().catch(() => {});
    return await summary({ lastDoneJob: lastMontageJob(jobs, tasks) });
  } catch (e) { return { error: String((e && e.message) || e) }; }
}
