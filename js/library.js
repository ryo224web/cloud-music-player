// Box の音楽フォルダをスキャンしてライブラリを作る
import { box, AUDIO_EXT, extOf } from './box.js';
import { idb } from './db.js';

export const baseName = (name) => name.replace(/\.[^.]+$/, '');

export async function loadLibrary() {
  return (await idb.get('kv', 'library')) || null;
}

export async function scanLibrary(root, onProgress) {
  const tracks = [];
  const lrc = {};
  const queue = [{ id: root.id, path: '' }];
  let folders = 0;

  const processFolder = async (f) => {
    const items = await box.folderItems(f.id);
    folders++;
    for (const it of items) {
      if (it.type === 'folder') {
        queue.push({ id: it.id, path: f.path ? `${f.path}/${it.name}` : it.name });
      } else if (it.type === 'file') {
        const ext = extOf(it.name);
        if (AUDIO_EXT.has(ext)) {
          tracks.push({ id: it.id, name: it.name, folderId: f.id, path: f.path, size: it.size, modified: it.modified_at });
        } else if (ext === 'lrc') {
          lrc[`${f.id}/${baseName(it.name).toLowerCase()}`] = it.id;
        }
      }
    }
    onProgress?.({ folders, tracks: tracks.length });
  };

  // 4 フォルダずつ並列で取得
  await new Promise((resolve, reject) => {
    let active = 0;
    let failed = false;
    const pump = () => {
      if (failed) return;
      if (!queue.length && !active) return resolve();
      while (active < 4 && queue.length) {
        active++;
        processFolder(queue.shift()).then(() => { active--; pump(); }, (e) => { failed = true; reject(e); });
      }
    };
    pump();
  });

  const collator = new Intl.Collator('ja', { numeric: true });
  tracks.sort((a, b) => collator.compare(a.path, b.path) || collator.compare(a.name, b.name));
  const lib = { rootId: root.id, rootName: root.name, tracks, lrc, scannedAt: Date.now() };
  await idb.set('kv', 'library', lib);
  return lib;
}
