/**
 * Автопроверка клипов: мост готовит «листы просмотра», Claude их смотрит и решает, пересъёмывать ли.
 *
 * Модели видео не умеет смотреть сам мост — смотрит Claude в своей сессии (подписка, без API).
 * Мост делает дешёвую и детерминированную часть: вынимает кадры (начало / середина / конец
 * каждого клипа, пара кадров на каждом стыке цепочки), меряет то, что меряется без зрения
 * (пустая заливка у края, чёрные и замёрзшие куски, длина против заказа, скачок на стыке),
 * и отдаёт картинки прямо в ответ инструмента. Пересъёмку делает /jobs/:id/redo в server.mjs.
 *
 * Нужен ffmpeg в PATH; без него листы не строятся, а проверка честно говорит, что не может.
 * Файл одинаковый в трёх мостах (OmniFlow, SeedFlow, SymFlow) — копии сверяет тест.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyzeClip, videoDuration } from './tesseract.mjs';

const VIDEO_RE = /\.(mp4|m4v|mov|webm)$/i;
export const MAX_TAKES = 3;          // первый дубль + две пересъёмки, дальше решает человек
export const SEAM_JUMP = 38;         // средняя разница яркостей 0–255 на стыке, выше — заметный скачок
const SIDE = 384;                    // длинная сторона кадра в листе: хватает глазу, мало весит

export const clipFile = (t) => ((t && t.files) || []).map((f) => f && f.file).find((f) => f && VIDEO_RE.test(String(f))) || null;

export function hasFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { timeout: 10_000, windowsHide: true });
  return !r.error && r.status === 0;
}

const ff = (args, timeout = 60_000) => spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', ...args],
  { timeout, windowsHide: true, maxBuffer: 4 << 20 });
const fit = `scale='if(gt(iw,ih),${SIDE},-2)':'if(gt(iw,ih),-2,${SIDE})'`;

/** Один кадр в jpeg: at — секунда от начала, отрицательное — от конца. */
export function grabFrame(file, at, out) {
  const seek = at < 0 ? ['-sseof', String(at)] : ['-ss', String(at)];
  const r = ff([...seek, '-i', file, '-frames:v', '1', '-q:v', '3', '-y', out]);
  return r.status === 0 && fs.existsSync(out) ? out : null;
}

/** Лист клипа: начало, середина, конец в один ряд. */
export function clipSheet(file, out) {
  const dur = videoDuration(file) || 0;
  const mid = dur > 1 ? dur / 2 : 0.5;
  const r = ff(['-ss', '0.3', '-i', file, '-ss', mid.toFixed(2), '-i', file, '-sseof', '-0.3', '-i', file,
    '-filter_complex', `[0:v]${fit}[a];[1:v]${fit}[b];[2:v]${fit}[c];[a][b][c]hstack=inputs=3`,
    '-frames:v', '1', '-q:v', '4', '-y', out]);
  return r.status === 0 && fs.existsSync(out) ? out : null;
}

/** Лист стыка: последний кадр прошлой сцены | первый кадр этой. */
export function seamSheet(prevFile, file, out) {
  const r = ff(['-sseof', '-0.15', '-i', prevFile, '-ss', '0.05', '-i', file,
    // разные клипы могут прийти в разном разрешении — hstack требует одной высоты
    '-filter_complex', '[0:v]scale=-2:360,setsar=1[a];[1:v]scale=-2:360,setsar=1[b];[a][b]hstack=inputs=2',
    '-frames:v', '1', '-q:v', '4', '-y', out]);
  return r.status === 0 && fs.existsSync(out) ? out : null;
}

/** Кадр в серый 48×48 — сравнивать стыки без зрения. */
function tinyGray(file, at) {
  const seek = at < 0 ? ['-sseof', String(at)] : ['-ss', String(at)];
  const r = ff([...seek, '-i', file, '-frames:v', '1', '-vf', 'scale=48:48,format=gray', '-f', 'rawvideo', '-']);
  return r.status === 0 && r.stdout && r.stdout.length >= 48 * 48 ? r.stdout.subarray(0, 48 * 48) : null;
}

/** Скачок на стыке: средняя разница яркостей (0 — один и тот же кадр, 255 — негатив). */
export function seamJump(prevFile, file) {
  const a = tinyGray(prevFile, -0.15), b = tinyGray(file, 0.05);
  if (!a || !b) return null;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return Math.round(s / a.length);
}

/** Чёрные и замёрзшие куски клипа (секунды). */
export function motionFlags(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vf', 'blackdetect=d=0.4:pix_th=0.10,freezedetect=n=0.003:d=1.5',
    '-an', '-f', 'null', '-'], { timeout: 90_000, windowsHide: true, maxBuffer: 8 << 20 });
  const err = String(r.stderr || '');
  const black = [...err.matchAll(/black_duration:([\d.]+)/g)].reduce((s, m) => s + Number(m[1]), 0);
  let frozen = [...err.matchAll(/freeze_duration:\s*([\d.]+)/g)].reduce((s, m) => s + Number(m[1]), 0);
  // заморозка до самого конца клипа: freeze_start есть, а freeze_end ffmpeg уже не пишет
  const starts = [...err.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...err.matchAll(/freeze_end:/g)].length;
  if (starts.length > ends) frozen += Math.max(0, (videoDuration(file) || 0) - starts[starts.length - 1]);
  return { blackSec: Math.round(black * 10) / 10, frozenSec: Math.round(frozen * 10) / 10 };
}

/**
 * Проверка задания: по каждому готовому клипу — лист и замеры, по каждому стыку цепочки — лист и скачок.
 * items — задачи задания по порядку (уже без заменённых дублей). Возвращает { clips, warnings, images }.
 */
export function reviewJob(job, items) {
  const dir = path.join(job.dir, '_qa');
  fs.mkdirSync(dir, { recursive: true });
  const clips = [], images = [], warnings = [];
  let prev = null;
  for (const t of items) {
    const file = clipFile(t);
    if (t.status !== 'done' || !file) {
      clips.push({ seq: t.seq, status: t.status, error: t.error || null });
      prev = null;
      continue;
    }
    const take = t.take || 1;
    const dur = videoDuration(file);
    const c = { seq: t.seq, take, takesLeft: Math.max(0, MAX_TAKES - take), file, prompt: t.prompt,
      durationSec: dur, requestedSec: t.length || null, chain: !!t.chain || !!t.chainFrom, flags: [] };
    const frame = analyzeClip(file);
    if (frame && frame.blank) c.flags.push(`flat ${frame.blank.pct}% band at the ${frame.blank.edge} edge`);
    const m = motionFlags(file);
    if (m.blackSec > 0) c.flags.push(`${m.blackSec}s of black frames`);
    if (m.frozenSec > 0) c.flags.push(`${m.frozenSec}s frozen (no motion)`);
    if (dur && t.length && dur < t.length - 0.75) c.flags.push(`clip is ${dur}s, ${t.length}s was ordered`);
    const sheet = clipSheet(file, path.join(dir, `${String(t.seq).padStart(2, '0')}-t${take}-clip.jpg`));
    if (sheet) { c.sheet = sheet; images.push({ file: sheet, label: `Scene ${t.seq} (take ${take}): start | middle | end` }); }
    if (c.chain && prev) {
      c.seamJump = seamJump(prev.file, file);
      if (c.seamJump !== null && c.seamJump > SEAM_JUMP) c.flags.push(`visible jump at the seam with scene ${prev.seq} (${c.seamJump}/255)`);
      const ss = seamSheet(prev.file, file, path.join(dir, `${String(t.seq).padStart(2, '0')}-t${take}-seam.jpg`));
      if (ss) { c.seamSheet = ss; images.push({ file: ss, label: `Seam ${prev.seq}→${t.seq}: last frame of ${prev.seq} | first frame of ${t.seq}` }); }
    }
    for (const f of c.flags) warnings.push(`scene ${t.seq}: ${f}`);
    clips.push(c);
    prev = c;
  }
  return { clips, warnings, images };
}

/** Что смотреть и когда пересъёмывать — Claude читает это вместе с картинками. */
export const RUBRIC = [
  'Look at every sheet. For each scene give a score 1–5 and a verdict "ok" or "redo".',
  'REDO (critical) if any: the hero differs from the character passport or from the previous scene (face, hair, clothes, product shape/colour/label);',
  'broken anatomy (extra or melted fingers/limbs, distorted face); garbled pseudo-text, fake logos or watermarks; split screen, panels, borders or a flat blank band;',
  'the action or setting clearly does not match the prompt; a hard visual jump on a chain seam (lighting, position, background change between the two seam frames).',
  'Score 3 with minor issues is acceptable — do not burn credits on taste. Measured flags from the bridge are hints, your eyes decide.',
  'For a redo call flow_redo with the scene number and a corrected prompt: keep the passport and style line word for word, fix only what failed, add explicit negatives for the defect.',
  'Three frames do not show motion: lip-sync and motion glitches are out of reach here — say so instead of guessing.',
  'When takesLeft is 0 stop and tell the user which scene is still weak and why.',
].join(' ');
