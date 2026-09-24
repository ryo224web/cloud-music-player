// IndexedDB の薄いラッパー
//  blobs     : fileId -> Blob（音声データ）
//  cacheinfo : fileId -> { size, savedAt, pinned }
//  meta      : fileId -> { title, artist, album, track, picture(Blob), lyrics }
//  kv        : 任意のキー -> 値（ライブラリ、プレイリスト、歌詞キャッシュなど）
const DB_NAME = 'boxmusic';
const DB_VERSION = 1;
const STORES = ['blobs', 'cacheinfo', 'meta', 'kv'];

let dbPromise;
function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        for (const s of STORES) {
          if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const idb = {
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  set: (store, key, value) => run(store, 'readwrite', (s) => s.put(value, key)),
  del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => run(store, 'readwrite', (s) => s.clear()),
  keys: (store) => run(store, 'readonly', (s) => s.getAllKeys()),
  values: (store) => run(store, 'readonly', (s) => s.getAll()),
  async entries(store) {
    const [k, v] = await Promise.all([this.keys(store), this.values(store)]);
    return k.map((key, i) => [key, v[i]]);
  },
};
