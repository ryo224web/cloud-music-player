// 再生キュー・シャッフル・リピートを管理するプレイヤー
const STATE_KEY = 'bm.player';

export class Player extends EventTarget {
  // loader(id, onProgress) -> Promise<Blob>
  constructor(audio, loader) {
    super();
    this.a = audio;
    this.loader = loader;
    this.ids = [];      // キューに入っている曲 ID
    this.order = [];    // 再生順（ids のインデックス）
    this.pos = -1;      // order 上の現在位置
    this.shuffle = false;
    this.repeat = 'off'; // off | all | one
    this.urls = new Map();
    this.seq = 0;
    this.loadedId = null;
    this.pendingSeek = 0;

    audio.addEventListener('ended', () => this.onEnded());
    for (const ev of ['play', 'pause', 'timeupdate', 'durationchange', 'waiting', 'playing']) {
      audio.addEventListener(ev, () => this.emit(ev));
    }
    audio.addEventListener('error', () => {
      if (audio.src) this.emit('error', { message: '再生できない形式か、ファイルが壊れています' });
    });
    setInterval(() => this.persist(), 5000);
    this.restore();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  get currentId() { return this.pos >= 0 && this.pos < this.order.length ? this.ids[this.order[this.pos]] : null; }
  get upcoming() { return this.order.slice(this.pos + 1).map((i) => this.ids[i]); }
  get paused() { return this.a.paused; }

  // 曲リストをキューにセットして start 番目から再生
  play(ids, start = 0, shuffle = this.shuffle) {
    if (!ids.length) return;
    this.ids = ids.slice();
    this.shuffle = shuffle;
    this.buildOrder(shuffle && start < 0 ? null : Math.max(0, start));
    return this.playPos(this.pos);
  }

  buildOrder(first) {
    const idx = this.ids.map((_, i) => i);
    if (this.shuffle) {
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      if (first != null) {
        idx.splice(idx.indexOf(first), 1);
        idx.unshift(first);
      }
      this.order = idx;
      this.pos = 0;
    } else {
      this.order = idx;
      this.pos = first ?? 0;
    }
  }

  setShuffle(on) {
    const cur = this.pos >= 0 ? this.order[this.pos] : null;
    this.shuffle = on;
    if (this.ids.length) this.buildOrder(cur);
    this.emit('queue');
    this.persist();
  }

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this.emit('queue');
    this.persist();
  }

  async urlFor(id, onProgress) {
    if (this.urls.has(id)) return this.urls.get(id);
    const blob = await this.loader(id, onProgress);
    const url = URL.createObjectURL(blob);
    this.urls.set(id, url);
    return url;
  }

  // 現在の曲と次の曲以外の ObjectURL を解放
  gc() {
    const keep = new Set([this.currentId, this.peekId()]);
    for (const [id, url] of this.urls) {
      if (!keep.has(id)) { URL.revokeObjectURL(url); this.urls.delete(id); }
    }
  }

  async playPos(pos, { autoplay = true, seek = 0 } = {}) {
    if (pos < 0 || pos >= this.order.length) return;
    const my = ++this.seq;
    this.pos = pos;
    const id = this.currentId;
    this.emit('track', { id });
    this.emit('queue');
    this.persist();
    let url;
    try {
      this.emit('loading', { id, progress: 0 });
      url = await this.urlFor(id, (p) => my === this.seq && this.emit('loading', { id, progress: p }));
    } catch (e) {
      if (my !== this.seq) return;
      this.emit('loading', { id, progress: null });
      this.emit('error', { message: e.message, id });
      return;
    }
    if (my !== this.seq) return;
    this.emit('loading', { id, progress: null });
    this.a.src = url;
    this.loadedId = id;
    if (seek) {
      const s = seek;
      this.a.addEventListener('loadedmetadata', () => { this.a.currentTime = s; }, { once: true });
    }
    if (autoplay) {
      try { await this.a.play(); } catch (e) { if (e.name !== 'AbortError') this.emit('error', { message: '再生を開始できませんでした（画面をタップしてください）' }); }
    }
    this.gc();
    this.prefetch();
  }

  peekPos() {
    if (this.pos + 1 < this.order.length) return this.pos + 1;
    return this.repeat === 'all' && this.order.length ? 0 : -1;
  }
  peekId() { const p = this.peekPos(); return p >= 0 ? this.ids[this.order[p]] : null; }

  // 次の曲を先に読み込んでおく（ロック中の曲送りを確実にするため）
  prefetch() {
    const id = this.peekId();
    if (id && !this.urls.has(id)) this.urlFor(id).catch(() => {});
  }

  onEnded() {
    if (this.repeat === 'one') {
      this.a.currentTime = 0;
      this.a.play().catch(() => {});
      return;
    }
    const p = this.peekPos();
    if (p >= 0) this.playPos(p);
    else this.emit('queue');
  }

  toggle() {
    if (!this.currentId) return;
    if (this.loadedId !== this.currentId) return this.playPos(this.pos, { seek: this.pendingSeek });
    if (this.a.paused) this.a.play().catch(() => {});
    else this.a.pause();
  }

  next() {
    const p = this.pos + 1 < this.order.length ? this.pos + 1 : this.order.length ? 0 : -1;
    if (p >= 0) this.playPos(p);
  }

  prev() {
    if (this.a.currentTime > 3 || this.pos <= 0 && this.repeat !== 'all') {
      this.a.currentTime = 0;
      if (this.loadedId !== this.currentId) this.playPos(this.pos);
      return;
    }
    this.playPos(this.pos > 0 ? this.pos - 1 : this.order.length - 1);
  }

  seek(t) {
    if (this.loadedId === this.currentId && isFinite(t)) this.a.currentTime = t;
  }

  jumpTo(orderPos) { this.playPos(orderPos); }

  playNext(id) {
    if (!this.ids.length) return this.play([id], 0);
    this.ids.push(id);
    this.order.splice(this.pos + 1, 0, this.ids.length - 1);
    this.emit('queue');
    this.persist();
  }

  enqueue(id) {
    if (!this.ids.length) return this.play([id], 0);
    this.ids.push(id);
    this.order.push(this.ids.length - 1);
    this.emit('queue');
    this.persist();
  }

  removeAt(orderPos) {
    if (orderPos === this.pos) return;
    this.order.splice(orderPos, 1);
    if (orderPos < this.pos) this.pos--;
    this.emit('queue');
    this.persist();
  }

  persist() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        ids: this.ids, order: this.order, pos: this.pos, shuffle: this.shuffle, repeat: this.repeat,
        time: this.loadedId === this.currentId ? this.a.currentTime : this.pendingSeek,
      }));
    } catch { /* 容量不足などは無視 */ }
  }

  // 前回の状態を復元（自動再生はしない）
  restore() {
    try {
      const s = JSON.parse(localStorage.getItem(STATE_KEY));
      if (!s || !Array.isArray(s.ids)) return;
      Object.assign(this, { ids: s.ids, order: s.order, pos: s.pos, shuffle: !!s.shuffle, repeat: s.repeat || 'off' });
      this.pendingSeek = s.time || 0;
    } catch { /* 壊れていたら無視 */ }
  }
}
