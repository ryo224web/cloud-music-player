// 10 バンドイコライザー（Web Audio API）
export const BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const PRESETS = {
  'フラット': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  '低音強調': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  '高音強調': [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  'ボーカル': [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1],
  'ロック': [4, 3, 2, 0, -1, -1, 1, 3, 4, 4],
  'ポップ': [-1, 1, 3, 4, 3, 0, -1, -1, 0, 1],
  'ジャズ': [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
  'クラシック': [4, 3, 2, 1, -1, -1, 0, 2, 3, 4],
  'ダンス': [6, 5, 2, 0, 0, -2, -1, 0, 3, 4],
  'アコースティック': [3, 3, 2, 1, 1, 1, 2, 2, 2, 1],
  '小音量向け': [6, 5, 3, 1, 0, 0, 0, 1, 3, 4],
  'イヤホン補正': [2, 1, 0, 0, -1, 0, 1, 2, 2, 1],
};

const KEY = 'bm.eq';
const DEFAULTS = {
  enabled: false,
  preset: 'フラット',
  gains: PRESETS['フラット'].slice(),
  preamp: 0,         // dB
  antiClip: true,    // ブースト分だけ全体を下げて音割れを防ぐ
  normalize: false,  // 音量の平準化（コンプレッサー）
};

const dbToGain = (db) => 10 ** (db / 20);

export class Equalizer {
  constructor(audio) {
    this.audio = audio;
    this.ctx = null;
    try { this.s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY)) }; } catch { this.s = { ...DEFAULTS }; }
  }

  get settings() { return this.s; }
  save() { localStorage.setItem(KEY, JSON.stringify(this.s)); }

  // ユーザー操作の中で呼ぶこと（iPhone は操作なしで AudioContext を開始できない）
  ensure() {
    if (!this.s.enabled || this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'playback' });
    this.ctx = ctx;
    this.src = ctx.createMediaElementSource(this.audio);
    this.pre = ctx.createGain();
    this.filters = BANDS.map((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f;
      b.Q.value = 1.2;
      return b;
    });
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -24;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 3;
    this.comp.attack.value = 0.005;
    this.comp.release.value = 0.25;
    this.makeup = ctx.createGain();
    this.src.connect(this.pre);
    this.filters.reduce((prev, f) => (prev.connect(f), f), this.pre);
    this.route();
    this.apply();
  }

  route() {
    if (!this.ctx) return;
    const last = this.filters[this.filters.length - 1];
    last.disconnect();
    this.comp.disconnect();
    this.makeup.disconnect();
    if (this.s.normalize && this.s.enabled) {
      last.connect(this.comp);
      this.comp.connect(this.makeup);
      this.makeup.connect(this.ctx.destination);
      this.makeup.gain.value = dbToGain(6);
    } else {
      last.connect(this.ctx.destination);
    }
  }

  apply() {
    if (!this.ctx) return;
    const on = this.s.enabled;
    const gains = on ? this.s.gains : BANDS.map(() => 0);
    const boost = Math.max(0, ...gains);
    const pre = on ? this.s.preamp - (this.s.antiClip ? boost : 0) : 0;
    const t = this.ctx.currentTime;
    this.pre.gain.setTargetAtTime(dbToGain(pre), t, 0.02);
    this.filters.forEach((f, i) => f.gain.setTargetAtTime(gains[i], t, 0.02));
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  setEnabled(on) {
    this.s.enabled = on;
    this.save();
    if (on) this.ensure();
    this.route();
    this.apply();
    this.resume();
  }

  setBand(i, db) {
    this.s.gains[i] = db;
    this.s.preset = 'カスタム';
    this.save();
    this.apply();
  }

  setPreset(name) {
    this.s.preset = name;
    this.s.gains = PRESETS[name].slice();
    this.save();
    this.apply();
  }

  set(key, value) {
    this.s[key] = value;
    this.save();
    this.route();
    this.apply();
  }
}
