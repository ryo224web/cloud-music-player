// 音声データのキャッシュ
//  pinned = true  : オフライン保存（自動削除しない）
//  pinned = false : 一時キャッシュ（上限を超えたら古いものから削除）
import { idb } from './db.js';

const LIMIT_KEY = 'bm.cacheLimit';
export const cacheLimit = {
  get() { return Number(localStorage.getItem(LIMIT_KEY)) || 1024 ** 3; },
  set(v) { localStorage.setItem(LIMIT_KEY, String(v)); },
};

// 端末側で勝手に消されにくくする（対応ブラウザのみ）
navigator.storage?.persist?.().catch(() => {});

export async function getBlob(id) {
  const blob = await idb.get('blobs', id);
  if (blob) {
    const info = await idb.get('cacheinfo', id);
    if (info) idb.set('cacheinfo', id, { ...info, usedAt: Date.now() }).catch(() => {});
  }
  return blob;
}

export async function putBlob(id, blob, pinned = false) {
  const prev = await idb.get('cacheinfo', id);
  await idb.set('blobs', id, blob);
  await idb.set('cacheinfo', id, { size: blob.size, usedAt: Date.now(), pinned: pinned || !!prev?.pinned });
  evict().catch(() => {});
}

export async function setPinned(id, pinned) {
  const info = await idb.get('cacheinfo', id);
  if (info) await idb.set('cacheinfo', id, { ...info, pinned });
}

export async function pinnedIds() {
  const entries = await idb.entries('cacheinfo');
  return new Set(entries.filter(([, v]) => v.pinned).map(([k]) => k));
}

export async function remove(id) {
  await idb.del('blobs', id);
  await idb.del('cacheinfo', id);
}

export async function stats() {
  const entries = await idb.entries('cacheinfo');
  const s = { pinnedCount: 0, pinnedSize: 0, tempCount: 0, tempSize: 0 };
  for (const [, v] of entries) {
    if (v.pinned) { s.pinnedCount++; s.pinnedSize += v.size; } else { s.tempCount++; s.tempSize += v.size; }
  }
  return s;
}

export async function evict(protect = []) {
  const limit = cacheLimit.get();
  const temp = (await idb.entries('cacheinfo')).filter(([k, v]) => !v.pinned && !protect.includes(k));
  let total = temp.reduce((a, [, v]) => a + v.size, 0);
  temp.sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [k, v] of temp) {
    if (total <= limit) break;
    await remove(k);
    total -= v.size;
  }
}

export async function clearTemp() {
  for (const [k, v] of await idb.entries('cacheinfo')) if (!v.pinned) await remove(k);
}

export async function clearAll() {
  await idb.clear('blobs');
  await idb.clear('cacheinfo');
}

export function formatBytes(n) {
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
