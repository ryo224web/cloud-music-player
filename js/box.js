// Box API クライアント
import { getToken, refresh } from './auth.js';

const API = 'https://api.box.com/2.0';
const UPLOAD = 'https://upload.box.com/api/2.0';

export class BoxError extends Error {
  constructor(status, body) {
    let msg = `Box API エラー (${status})`;
    let json = null;
    try { json = JSON.parse(body); msg += `: ${json.message || json.code}`; } catch { /* 本文なし */ }
    super(msg);
    this.status = status;
    this.json = json;
  }
}

const MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', alac: 'audio/mp4',
  flac: 'audio/flac', wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm',
};
export const AUDIO_EXT = new Set(Object.keys(MIME));
export const extOf = (name) => (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
export const mimeOf = (name) => MIME[extOf(name)] || 'application/octet-stream';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 日本語の古いファイル（Shift_JIS）にも対応してテキストを復号
export function decodeText(buf) {
  const bytes = new Uint8Array(buf);
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start));
  } catch {
    try { return new TextDecoder('shift_jis').decode(bytes); } catch { return new TextDecoder().decode(bytes); }
  }
}

export const box = {
  async fetch(url, opts = {}, attempt = 0) {
    const token = await getToken();
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
    if (res.status === 401 && attempt === 0) {
      await refresh();
      return this.fetch(url, opts, attempt + 1);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const wait = Number(res.headers.get('Retry-After')) * 1000 || 800 * 2 ** attempt;
      await sleep(wait);
      return this.fetch(url, opts, attempt + 1);
    }
    if (!res.ok) throw new BoxError(res.status, await res.text().catch(() => ''));
    return res;
  },

  async json(path, opts) {
    return (await this.fetch(API + path, opts)).json();
  },

  me() { return this.json('/users/me?fields=name,login'); },

  folder(id) { return this.json(`/folders/${id}?fields=id,name,path_collection`); },

  async folderItems(id) {
    const items = [];
    let marker = '';
    do {
      const q = `fields=id,type,name,size,modified_at&limit=1000&usemarker=true${marker ? `&marker=${encodeURIComponent(marker)}` : ''}`;
      const r = await this.json(`/folders/${id}/items?${q}`);
      items.push(...r.entries);
      marker = r.next_marker || '';
    } while (marker);
    return items;
  },

  // ファイル本体をダウンロード（進捗コールバック付き）
  async download(id, name, onProgress) {
    const res = await this.fetch(`${API}/files/${id}/content`, { cache: 'no-store' });
    const total = Number(res.headers.get('Content-Length')) || 0;
    let blob;
    if (onProgress && res.body && total) {
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        onProgress(got / total);
      }
      blob = new Blob(chunks);
    } else {
      blob = await res.blob();
    }
    // iPhone の Safari は MIME が正しくないと再生できないため付け直す
    return name ? new Blob([blob], { type: mimeOf(name) }) : blob;
  },

  async downloadText(id) {
    const blob = await this.download(id);
    return decodeText(await blob.arrayBuffer());
  },

  // テキストファイルをアップロード（fileId があれば新しいバージョンとして上書き）
  async uploadText(parentId, name, text, fileId) {
    const form = new FormData();
    form.append('attributes', JSON.stringify(fileId ? { name } : { name, parent: { id: parentId } }));
    form.append('file', new Blob([text], { type: 'application/json' }), name);
    const url = fileId ? `${UPLOAD}/files/${fileId}/content` : `${UPLOAD}/files/content`;
    const res = await this.fetch(url, { method: 'POST', body: form });
    return (await res.json()).entries[0];
  },

  async findFile(folderId, name) {
    const items = await this.folderItems(folderId);
    return items.find((i) => i.type === 'file' && i.name === name) || null;
  },
};
