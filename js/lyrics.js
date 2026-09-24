// 歌詞の取得
//  1. Box の同じフォルダにある「曲名.lrc」
//  2. 曲ファイルに埋め込まれた歌詞タグ
//  3. LRCLIB（無料の歌詞データベース, https://lrclib.net）
import { idb } from './db.js';
import { box } from './box.js';

export function parseLRC(text) {
  const lines = [];
  let offset = 0;
  for (const raw of text.split(/\r?\n/)) {
    const off = raw.match(/^\[offset:\s*([+-]?\d+)\]/i);
    if (off) { offset = Number(off[1]) / 1000; continue; }
    const tags = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!tags.length) continue;
    const words = raw.replace(/\[[^\]]*\]/g, '').replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim();
    for (const [, m, s] of tags) {
      lines.push({ t: Number(m) * 60 + Number(s.replace(':', '.')), text: words });
    }
  }
  if (lines.length < 2) return null;
  lines.sort((a, b) => a.t - b.t);
  if (offset) lines.forEach((l) => { l.t = Math.max(0, l.t - offset); });
  return lines;
}

function toResult(text, source) {
  if (!text) return null;
  const synced = parseLRC(text);
  return { synced, plain: synced ? null : text.trim(), source };
}

async function fromLrclib(title, artist, album, duration) {
  if (!title) return null;
  const base = 'https://lrclib.net/api';
  if (artist && duration) {
    const q = new URLSearchParams({ track_name: title, artist_name: artist, duration: String(Math.round(duration)) });
    if (album) q.set('album_name', album);
    const res = await fetch(`${base}/get?${q}`);
    if (res.ok) {
      const j = await res.json();
      if (j.syncedLyrics || j.plainLyrics) return j;
    }
  }
  const q = new URLSearchParams({ track_name: title });
  if (artist) q.set('artist_name', artist);
  const res = await fetch(`${base}/search?${q}`);
  if (!res.ok) return null;
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) return null;
  // 再生時間が近いもの・同期歌詞があるものを優先
  const score = (j) => (j.syncedLyrics ? 0 : 1000) + (duration ? Math.abs((j.duration || 0) - duration) : 0);
  return list.sort((a, b) => score(a) - score(b))[0];
}

export async function findLyrics({ track, meta, info, lrcFileId, duration, force = false }) {
  const key = `lyrics:${track.id}`;
  if (!force) {
    const cached = await idb.get('kv', key);
    // 「見つからなかった」結果は 7 日で再検索
    if (cached && (cached.found || Date.now() - cached.at < 7 * 864e5)) return cached.found ? cached : null;
  }
  let result = null;
  if (lrcFileId) {
    try { result = toResult(await box.downloadText(lrcFileId), 'Box の .lrc ファイル'); } catch (e) { console.warn(e); }
  }
  if (!result && meta?.lyrics) result = toResult(meta.lyrics, '曲ファイルの埋め込み歌詞');
  if (!result && navigator.onLine) {
    try {
      const j = await fromLrclib(info.title, info.artist, meta?.album, duration);
      if (j) result = toResult(j.syncedLyrics || j.plainLyrics, 'LRCLIB');
    } catch (e) { console.warn(e); }
  }
  if (!result && !navigator.onLine) return null; // オフライン時は「なし」と記録しない
  const record = result ? { ...result, found: true, at: Date.now() } : { found: false, at: Date.now() };
  await idb.set('kv', key, record);
  return result;
}
