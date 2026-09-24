// プレイリスト（Box 上の JSON ファイルで Mac / iPhone 間を同期）
import { box, BoxError } from './box.js';
import { idb } from './db.js';

export const FILE_NAME = 'boxmusic-playlists.json';

export class Playlists extends EventTarget {
  constructor() {
    super();
    this.data = { items: [] };
    this.syncing = null;
    this.timer = null;
    this.rootId = null;
  }

  async load() {
    this.data = (await idb.get('kv', 'playlists')) || { items: [] };
  }

  get list() {
    return this.data.items.filter((p) => !p.deleted).sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
  }
  get(id) { return this.data.items.find((p) => p.id === id && !p.deleted); }

  async save() {
    await idb.set('kv', 'playlists', this.data);
    this.dispatchEvent(new Event('change'));
    this.scheduleSync();
  }

  touch(p) { p.updatedAt = Date.now(); }

  async create(name, tracks = []) {
    const p = { id: crypto.randomUUID(), name, tracks, updatedAt: Date.now() };
    this.data.items.push(p);
    await this.save();
    return p;
  }
  async rename(id, name) { const p = this.get(id); p.name = name; this.touch(p); await this.save(); }
  async remove(id) { const p = this.get(id); p.deleted = true; p.tracks = []; this.touch(p); await this.save(); }
  async addTracks(id, trackIds) {
    const p = this.get(id);
    p.tracks.push(...trackIds);
    this.touch(p);
    await this.save();
  }
  async removeAt(id, index) { const p = this.get(id); p.tracks.splice(index, 1); this.touch(p); await this.save(); }
  async move(id, from, to) {
    const p = this.get(id);
    if (to < 0 || to >= p.tracks.length) return;
    const [t] = p.tracks.splice(from, 1);
    p.tracks.splice(to, 0, t);
    this.touch(p);
    await this.save();
  }

  scheduleSync() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sync().catch(() => {}), 1500);
  }

  // 双方の更新日時を比べて新しい方を採用し、結果を Box に書き戻す
  sync() {
    if (!this.rootId) return Promise.resolve(false);
    if (!this.syncing) {
      this.syncing = this._sync().finally(() => { this.syncing = null; });
      this.dispatchEvent(new CustomEvent('sync', { detail: 'start' }));
      this.syncing.then(
        () => this.dispatchEvent(new CustomEvent('sync', { detail: 'done' })),
        (e) => this.dispatchEvent(new CustomEvent('sync', { detail: 'error', error: e })),
      );
    }
    return this.syncing;
  }

  async _sync(retried = false) {
    const fileKey = `playlistsFile:${this.rootId}`;
    let fileId = await idb.get('kv', fileKey);
    let remote = null;
    if (fileId) {
      try { remote = JSON.parse(await box.downloadText(fileId)); } catch (e) {
        if (e instanceof BoxError && e.status === 404) fileId = null; else if (!(e instanceof SyntaxError)) throw e;
      }
    }
    if (!fileId) {
      const f = await box.findFile(this.rootId, FILE_NAME);
      if (f) {
        fileId = f.id;
        try { remote = JSON.parse(await box.downloadText(fileId)); } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
      }
    }

    const map = new Map();
    for (const p of remote?.items || []) map.set(p.id, p);
    let remoteChanged = !remote;
    let localChanged = false;
    for (const p of this.data.items) {
      const r = map.get(p.id);
      if (!r || p.updatedAt > r.updatedAt) { map.set(p.id, p); remoteChanged = true; }
    }
    for (const r of remote?.items || []) {
      const l = this.data.items.find((p) => p.id === r.id);
      if (!l || r.updatedAt > l.updatedAt) localChanged = true;
    }
    // 削除済みは 90 日で完全に消す
    const cutoff = Date.now() - 90 * 864e5;
    const items = [...map.values()].filter((p) => !(p.deleted && p.updatedAt < cutoff));
    this.data = { items };
    await idb.set('kv', 'playlists', this.data);
    if (localChanged) this.dispatchEvent(new Event('change'));

    if (remoteChanged) {
      const text = JSON.stringify({ app: 'BoxMusic', version: 1, items }, null, 1);
      let entry;
      try {
        entry = await box.uploadText(this.rootId, FILE_NAME, text, fileId);
      } catch (e) {
        // 他の端末が先に作成していた場合は、そのファイルと統合し直す
        const conflict = e instanceof BoxError && e.status === 409 && e.json?.context_info?.conflicts?.id;
        if (!conflict || retried) throw e;
        await idb.set('kv', fileKey, conflict);
        return this._sync(true);
      }
      fileId = entry.id;
    }
    await idb.set('kv', fileKey, fileId);
    return true;
  }
}
