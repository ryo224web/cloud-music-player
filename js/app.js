import * as auth from './auth.js';
import { box } from './box.js';
import { idb } from './db.js';
import * as cache from './cache.js';
import { readTags } from './tags.js';
import { Player } from './player.js';
import { Equalizer, BANDS, PRESETS } from './eq.js';
import { findLyrics } from './lyrics.js';
import { loadLibrary, scanLibrary, baseName } from './library.js';
import { Playlists } from './playlists.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

const audio = $('#audio');
const eq = new Equalizer(audio);
const playlists = new Playlists();
const meta = new Map();         // fileId -> タグ情報
const artUrls = new Map();      // fileId -> ジャケット画像 URL
let library = null;
let trackMap = new Map();
let pinned = new Set();
const ui = { tab: 'library', playlistId: null, q: '', offlineOnly: false, lyricsOn: false, lyrics: null, lyricIdx: -1 };

// ---------------- ユーティリティ ----------------
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function setStatus(text) { $('#status').textContent = text || ''; }

function info(id) {
  const t = trackMap.get(id);
  const m = meta.get(id) || {};
  const fname = t ? baseName(t.name) : '（見つからない曲）';
  // 「アーティスト - 曲名」形式のファイル名にも対応
  const dash = fname.match(/^(.+?)\s+-\s+(.+)$/);
  const folder = t?.path.split('/').filter(Boolean);
  return {
    title: m.title || (dash ? dash[2] : fname.replace(/^\d{1,3}[\s._-]+/, '')),
    artist: m.artist || m.albumArtist || (dash ? dash[1] : folder?.[folder.length - 2] || ''),
    album: m.album || folder?.[folder.length - 1] || '',
    path: t?.path || '',
  };
}

function artUrl(id) {
  const m = meta.get(id);
  if (!m?.picture) return null;
  if (!artUrls.has(id)) artUrls.set(id, URL.createObjectURL(m.picture));
  return artUrls.get(id);
}

async function ensureMeta(id, blob) {
  if (meta.has(id)) return meta.get(id);
  const tags = await readTags(blob);
  meta.set(id, tags);
  idb.set('meta', id, tags).catch(() => {});
  return tags;
}

// ---------------- プレイヤー ----------------
async function loadTrack(id, onProgress) {
  let blob = await cache.getBlob(id);
  if (!blob) {
    if (!navigator.onLine) throw new Error('オフラインのため、保存されていない曲は再生できません');
    const t = trackMap.get(id);
    blob = await box.download(id, t?.name, onProgress);
    await cache.putBlob(id, blob);
  }
  await ensureMeta(id, blob);
  if (id === player.currentId) renderNowMeta();
  return blob;
}

const player = new Player(audio, loadTrack);

player.addEventListener('track', () => {
  renderNowMeta();
  markPlaying();
  ui.lyrics = null;
  ui.lyricIdx = -1;
  if (ui.lyricsOn) loadLyrics();
});
player.addEventListener('play', () => { eq.resume(); renderPlayState(); });
player.addEventListener('pause', renderPlayState);
player.addEventListener('timeupdate', onTime);
player.addEventListener('durationchange', onTime);
player.addEventListener('queue', () => { renderModes(); if (sheetKind === 'queue') openQueue(); });
player.addEventListener('loading', (e) => {
  const p = e.detail.progress;
  $('#loadInfo').textContent = p == null ? '' : `読み込み中 ${Math.round(p * 100)}%`;
});
player.addEventListener('error', (e) => toast(e.detail.message));
player.addEventListener('playing', () => { if (ui.lyricsOn && !ui.lyrics) loadLyrics(); });

function userPlay(fn) {
  // iPhone では、ユーザー操作の中でイコライザーを開始する必要がある
  eq.ensure();
  eq.resume();
  return fn();
}

function renderPlayState() {
  const icon = audio.paused ? '▶' : '⏸';
  $('#btnPlay').textContent = icon;
  $('#miniPlay').textContent = icon;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
}

function renderModes() {
  $('#btnShuffle').classList.toggle('on', player.shuffle);
  const r = $('#btnRepeat');
  r.classList.toggle('on', player.repeat !== 'off');
  r.innerHTML = player.repeat === 'one' ? '🔂' : '🔁';
}

function renderNowMeta() {
  const id = player.currentId;
  const mini = $('#mini');
  mini.hidden = !id;
  document.body.classList.toggle('has-mini', !!id);
  if (!id) return;
  const i = info(id);
  $('#nowTitle').textContent = i.title;
  $('#nowArtist').textContent = [i.artist, i.album].filter(Boolean).join(' — ');
  $('#miniTitle').textContent = i.title;
  $('#miniArtist').textContent = i.artist;
  const art = artUrl(id);
  $('#nowArt').hidden = !art;
  $('#nowArtPh').hidden = !!art;
  $('#miniArt').hidden = !art;
  if (art) { $('#nowArt').src = art; $('#miniArt').src = art; }
  if ('mediaSession' in navigator) {
    const m = meta.get(id);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: i.title,
      artist: i.artist,
      album: i.album,
      artwork: art ? [{ src: art, sizes: '512x512', type: m.picture.type }] : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }
  if (ui.tab === 'now') $('#viewTitle').textContent = '再生中';
}

let lastPosUpdate = 0;
function onTime() {
  const d = audio.duration;
  const t = audio.currentTime;
  if (!seeking) $('#seek').value = d ? Math.round((t / d) * 1000) : 0;
  $('#tCur').textContent = fmtTime(t);
  $('#tDur').textContent = fmtTime(d);
  $('#miniBar').style.width = d ? `${(t / d) * 100}%` : '0';
  if (ui.lyrics?.synced) highlightLyric(t);
  if ('mediaSession' in navigator && d && Date.now() - lastPosUpdate > 1000) {
    lastPosUpdate = Date.now();
    try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(t, d), playbackRate: audio.playbackRate }); } catch { /* 未対応 */ }
  }
}

let seeking = false;
$('#seek').addEventListener('input', () => {
  seeking = true;
  const d = audio.duration;
  if (d) $('#tCur').textContent = fmtTime(($('#seek').value / 1000) * d);
});
$('#seek').addEventListener('change', () => {
  seeking = false;
  const d = audio.duration;
  if (d) player.seek(($('#seek').value / 1000) * d);
});

$('#btnPlay').onclick = () => userPlay(() => player.toggle());
$('#miniPlay').onclick = () => userPlay(() => player.toggle());
$('#btnNext').onclick = () => userPlay(() => player.next());
$('#miniNext').onclick = () => userPlay(() => player.next());
$('#btnPrev').onclick = () => userPlay(() => player.prev());
$('#btnShuffle').onclick = () => { player.setShuffle(!player.shuffle); toast(player.shuffle ? 'シャッフル: オン' : 'シャッフル: オフ'); };
$('#btnRepeat').onclick = () => { player.cycleRepeat(); toast({ off: 'リピート: オフ', all: 'リピート: 全曲', one: 'リピート: 1曲' }[player.repeat]); };
$('#miniOpen').onclick = () => showTab('now');

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch { /* 未対応 */ } };
  set('play', () => { eq.resume(); player.toggle(); });
  set('pause', () => audio.pause());
  set('previoustrack', () => player.prev());
  set('nexttrack', () => player.next());
  set('seekto', (d) => player.seek(d.seekTime));
  set('seekbackward', (d) => player.seek(audio.currentTime - (d.seekOffset || 10)));
  set('seekforward', (d) => player.seek(audio.currentTime + (d.seekOffset || 10)));
}

// ---------------- 画面切り替え ----------------
const TITLES = { library: 'ライブラリ', playlists: 'プレイリスト', now: '再生中', settings: '設定' };
function showView(name, title) {
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  $('#viewTitle').textContent = title;
  $('#btnBack').hidden = name !== 'playlist';
  window.scrollTo(0, 0);
}
function showTab(tab) {
  ui.tab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  showView(tab, TITLES[tab]);
  if (tab === 'library') renderLibrary();
  if (tab === 'playlists') renderPlaylists();
  if (tab === 'settings') renderSettings();
}
document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
$('#btnBack').onclick = () => showTab('playlists');

// ---------------- 曲リスト共通 ----------------
function trackRow(id, extra = '') {
  const i = info(id);
  const badge = pinned.has(id) ? '<span class="badge" title="オフライン保存済み">⬇</span>' : '';
  return `<li data-id="${esc(id)}" ${extra} class="${id === player.currentId ? 'playing' : ''}">
    <div class="main"><div class="t">${esc(i.title)}</div><div class="s">${badge} ${esc([i.artist, i.path].filter(Boolean).join(' · '))}</div></div>
    <button class="more" aria-label="メニュー">⋯</button></li>`;
}

function markPlaying() {
  const cur = player.currentId;
  document.querySelectorAll('.list li[data-id]').forEach((li) => li.classList.toggle('playing', li.dataset.id === cur));
}

// 大量の曲でも重くならないよう、少しずつ描画する
function renderChunked(ul, ids, rowFn) {
  const CHUNK = 200;
  let shown = 0;
  ul.innerHTML = '';
  const more = () => {
    ul.querySelector('.more-row')?.remove();
    const html = ids.slice(shown, shown + CHUNK).map((id, k) => rowFn(id, shown + k)).join('');
    ul.insertAdjacentHTML('beforeend', html);
    shown += CHUNK;
    if (shown < ids.length) {
      ul.insertAdjacentHTML('beforeend', '<li class="more-row">さらに表示…</li>');
      const sentinel = ul.querySelector('.more-row');
      const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) { io.disconnect(); more(); } });
      io.observe(sentinel);
    }
  };
  more();
}

// ---------------- ライブラリ ----------------
function filteredLibrary() {
  if (!library) return [];
  const q = ui.q.trim().toLowerCase();
  let ids = library.tracks.map((t) => t.id);
  if (ui.offlineOnly) ids = ids.filter((id) => pinned.has(id));
  if (q) {
    const words = q.split(/\s+/);
    ids = ids.filter((id) => {
      const t = trackMap.get(id);
      const i = info(id);
      const hay = `${i.title} ${i.artist} ${i.album} ${t.name} ${t.path}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  return ids;
}

function renderLibrary() {
  const ids = filteredLibrary();
  const libInfo = $('#libInfo');
  if (!library) {
    libInfo.innerHTML = auth.isLoggedIn()
      ? '設定画面で音楽フォルダを選んでください。'
      : 'まず設定画面で Box にログインしてください。';
    $('#trackList').innerHTML = '';
    return;
  }
  libInfo.textContent = `${ids.length} 曲${ids.length !== library.tracks.length ? ` / 全 ${library.tracks.length} 曲` : ''} · ${library.rootName}`;
  renderChunked($('#trackList'), ids, (id) => trackRow(id));
}

let qTimer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { ui.q = e.target.value; renderLibrary(); }, 150);
});
$('#btnPlayAll').onclick = () => userPlay(() => player.play(filteredLibrary(), 0, false));
$('#btnShuffleAll').onclick = () => userPlay(() => player.play(filteredLibrary(), -1, true));
$('#btnOfflineOnly').onclick = (e) => {
  ui.offlineOnly = !ui.offlineOnly;
  e.currentTarget.setAttribute('aria-pressed', String(ui.offlineOnly));
  renderLibrary();
};
$('#trackList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const id = li.dataset.id;
  if (e.target.closest('.more')) return openTrackMenu(id);
  const ids = filteredLibrary();
  userPlay(() => player.play(ids, ids.indexOf(id), player.shuffle));
});

// ---------------- プレイリスト ----------------
function renderPlaylists() {
  const list = playlists.list;
  $('#playlistList').innerHTML = list.length
    ? list.map((p) => `<li data-pl="${esc(p.id)}"><div class="main"><div class="t">${esc(p.name)}</div><div class="s">${p.tracks.length} 曲</div></div><span class="muted">›</span></li>`).join('')
    : '<li class="muted">プレイリストはまだありません</li>';
}

$('#playlistList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-pl]');
  if (li) openPlaylist(li.dataset.pl);
});

function openPlaylist(id) {
  const p = playlists.get(id);
  if (!p) return showTab('playlists');
  ui.playlistId = id;
  showView('playlist', p.name);
  renderPlaylist();
}

function renderPlaylist() {
  const p = playlists.get(ui.playlistId);
  if (!p) return;
  const missing = p.tracks.filter((id) => !trackMap.has(id)).length;
  const saved = p.tracks.filter((id) => pinned.has(id)).length;
  $('#plInfo').textContent = `${p.tracks.length} 曲 · オフライン保存 ${saved}/${p.tracks.length}${missing ? ` · 見つからない曲 ${missing}` : ''}`;
  renderChunked($('#plTracks'), p.tracks, (id, idx) => trackRow(id, `data-idx="${idx}"`));
}

$('#plTracks').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const idx = Number(li.dataset.idx);
  if (e.target.closest('.more')) return openTrackMenu(li.dataset.id, { playlistId: ui.playlistId, index: idx });
  const p = playlists.get(ui.playlistId);
  userPlay(() => player.play(p.tracks.filter((id) => trackMap.has(id)), p.tracks.filter((id, i) => i < idx && trackMap.has(id)).length, player.shuffle));
});
$('#btnPlPlay').onclick = () => { const p = playlists.get(ui.playlistId); userPlay(() => player.play(p.tracks.filter((id) => trackMap.has(id)), 0, false)); };
$('#btnPlShuffle').onclick = () => { const p = playlists.get(ui.playlistId); userPlay(() => player.play(p.tracks.filter((id) => trackMap.has(id)), -1, true)); };
$('#btnPlOffline').onclick = () => { const p = playlists.get(ui.playlistId); saveOffline(p.tracks.filter((id) => trackMap.has(id))); };
$('#btnPlMenu').onclick = () => {
  const p = playlists.get(ui.playlistId);
  openMenu(p.name, [
    ['名前を変更', async () => { const n = prompt('新しい名前', p.name); if (n?.trim()) { await playlists.rename(p.id, n.trim()); showView('playlist', n.trim()); } }],
    ['オフライン保存を解除', () => unpin(p.tracks)],
    ['プレイリストを削除', async () => { if (confirm(`「${p.name}」を削除しますか？`)) { await playlists.remove(p.id); showTab('playlists'); } }, 'danger'],
  ]);
};
$('#btnNewPlaylist').onclick = async () => {
  const name = prompt('プレイリスト名');
  if (!name?.trim()) return;
  await playlists.create(name.trim());
  renderPlaylists();
};
$('#btnSync').onclick = () => playlists.sync().catch(() => {});

playlists.addEventListener('change', () => {
  if (ui.tab === 'playlists') {
    if (!$('#view-playlist').hidden) renderPlaylist(); else renderPlaylists();
  }
});
playlists.addEventListener('sync', (e) => {
  if (e.detail === 'start') setStatus('同期中…');
  else if (e.detail === 'done') setStatus('');
  else { setStatus('同期失敗'); console.warn(e.error); }
});

// ---------------- メニュー（ボトムシート） ----------------
let sheetKind = null;
function openSheet(title, html, kind = 'menu') {
  sheetKind = kind;
  $('#sheetTitle').textContent = title;
  $('#sheetContent').innerHTML = html;
  $('#sheet').hidden = false;
}
function closeSheet() { $('#sheet').hidden = true; sheetKind = null; }
$('#sheet').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });

function openMenu(title, items) {
  openSheet(title, `<div class="menu">${items.map(([label, , cls], i) => `<button data-i="${i}" class="${cls || ''}">${esc(label)}</button>`).join('')}</div>`);
  $('#sheetContent').querySelectorAll('button[data-i]').forEach((b) => {
    b.onclick = () => { closeSheet(); items[b.dataset.i][1](); };
  });
}

function openTrackMenu(id, ctx = {}) {
  const i = info(id);
  const items = [
    ['次に再生', () => { player.playNext(id); toast('次に再生します'); }],
    ['再生キューに追加', () => { player.enqueue(id); toast('キューに追加しました'); }],
    ['プレイリストに追加', () => choosePlaylist([id])],
    pinned.has(id) ? ['オフライン保存を解除', () => unpin([id])] : ['オフライン保存', () => saveOffline([id])],
  ];
  if (ctx.playlistId) {
    const p = playlists.get(ctx.playlistId);
    items.push(
      ['上へ移動', () => playlists.move(p.id, ctx.index, ctx.index - 1)],
      ['下へ移動', () => playlists.move(p.id, ctx.index, ctx.index + 1)],
      ['このプレイリストから削除', () => playlists.removeAt(p.id, ctx.index), 'danger'],
    );
  }
  openMenu(i.title, items);
}

function choosePlaylist(ids) {
  const list = playlists.list;
  openMenu('プレイリストに追加', [
    ['＋ 新しいプレイリスト', async () => {
      const name = prompt('プレイリスト名');
      if (name?.trim()) { await playlists.create(name.trim(), ids); toast(`「${name.trim()}」に追加しました`); }
    }],
    ...list.map((p) => [p.name, async () => { await playlists.addTracks(p.id, ids); toast(`「${p.name}」に追加しました`); }]),
  ]);
}

// ---------------- オフライン保存 ----------------
let offlineBusy = false;
async function saveOffline(ids) {
  if (offlineBusy) return toast('保存処理中です');
  offlineBusy = true;
  let done = 0;
  let failed = 0;
  try {
    for (const id of ids) {
      setStatus(`保存中 ${done + 1}/${ids.length}`);
      try {
        let blob = await cache.getBlob(id);
        if (!blob) {
          blob = await box.download(id, trackMap.get(id)?.name);
          await cache.putBlob(id, blob, true);
        } else {
          await cache.setPinned(id, true);
        }
        ensureMeta(id, blob).catch(() => {});
        pinned.add(id);
      } catch (e) {
        console.warn(e);
        failed++;
      }
      done++;
    }
  } finally {
    offlineBusy = false;
    setStatus('');
  }
  toast(failed ? `${done - failed} 曲を保存（${failed} 曲失敗）` : `${done} 曲をオフライン保存しました`);
  refreshLists();
}

async function unpin(ids) {
  for (const id of ids) { await cache.setPinned(id, false); pinned.delete(id); }
  await cache.evict([player.currentId]);
  toast('オフライン保存を解除しました');
  refreshLists();
}

function refreshLists() {
  if (ui.tab === 'library') renderLibrary();
  if (!$('#view-playlist').hidden) renderPlaylist();
  if (ui.tab === 'settings') renderSettings();
}

// ---------------- 再生中画面のボタン ----------------
function openQueue() {
  const cur = player.currentId;
  const rows = [];
  if (cur) rows.push(`<li class="playing"><div class="main"><div class="t">${esc(info(cur).title)}</div><div class="s">再生中</div></div></li>`);
  const start = player.pos + 1;
  player.order.slice(start, start + 300).forEach((qi, k) => {
    const id = player.ids[qi];
    rows.push(`<li data-q="${start + k}"><span class="num">${k + 1}</span><div class="main"><div class="t">${esc(info(id).title)}</div><div class="s">${esc(info(id).artist)}</div></div><button class="more" data-rm="${start + k}" aria-label="削除">✕</button></li>`);
  });
  const repeatNote = player.repeat === 'all' ? '（リピート: 全曲）' : '';
  openSheet(`再生キュー ${repeatNote}`, `<ul class="list">${rows.join('') || '<li class="muted">キューは空です</li>'}</ul>`, 'queue');
  $('#sheetContent').querySelector('.list').onclick = (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) return player.removeAt(Number(rm.dataset.rm));
    const li = e.target.closest('li[data-q]');
    if (li) userPlay(() => player.jumpTo(Number(li.dataset.q)));
  };
}
$('#btnQueue').onclick = openQueue;
$('#btnNowMenu').onclick = () => { if (player.currentId) openTrackMenu(player.currentId); };

// ---------------- 歌詞 ----------------
$('#btnLyrics').onclick = () => {
  ui.lyricsOn = !ui.lyricsOn;
  $('#btnLyrics').setAttribute('aria-pressed', String(ui.lyricsOn));
  $('#lyrics').hidden = !ui.lyricsOn;
  if (ui.lyricsOn) loadLyrics();
};

async function loadLyrics(force = false) {
  const id = player.currentId;
  const el = $('#lyrics');
  if (!id) { el.innerHTML = '<p>再生していません</p>'; return; }
  const t = trackMap.get(id);
  el.className = 'lyrics plain';
  el.innerHTML = '<p class="muted">歌詞を探しています…</p>';
  if (!meta.has(id)) {
    const b = await cache.getBlob(id);
    if (b) await ensureMeta(id, b);
  }
  if (!audio.duration && player.loadedId !== id) return; // 読み込み後に playing イベントで再試行
  const res = await findLyrics({
    track: { id },
    meta: meta.get(id),
    info: info(id),
    lrcFileId: t && library?.lrc[`${t.folderId}/${baseName(t.name).toLowerCase()}`],
    duration: audio.duration,
    force,
  }).catch(() => null);
  if (player.currentId !== id) return;
  ui.lyrics = res || { synced: null, plain: null };
  ui.lyricIdx = -1;
  if (!res) {
    el.innerHTML = '<p>歌詞が見つかりませんでした</p><p class="small muted">Box の曲と同じフォルダに「曲ファイル名.lrc」を置くと表示されます</p><p><button class="chip" id="lyrRetry">再検索</button></p>';
  } else if (res.synced) {
    el.className = 'lyrics';
    el.innerHTML = res.synced.map((l, i) => `<p data-i="${i}" data-t="${l.t}">${esc(l.text) || '♪'}</p>`).join('') + `<div class="src">出典: ${esc(res.source)}</div>`;
    highlightLyric(audio.currentTime);
  } else {
    el.innerHTML = res.plain.split(/\r?\n/).map((l) => `<p>${esc(l) || '&nbsp;'}</p>`).join('') + `<div class="src">出典: ${esc(res.source)}</div>`;
  }
  el.querySelector('#lyrRetry')?.addEventListener('click', () => loadLyrics(true));
}

$('#lyrics').addEventListener('click', (e) => {
  const p = e.target.closest('p[data-t]');
  if (p) player.seek(Number(p.dataset.t));
});

function highlightLyric(t) {
  const lines = ui.lyrics.synced;
  let lo = 0, hi = lines.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= t + 0.2) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx === ui.lyricIdx) return;
  ui.lyricIdx = idx;
  const el = $('#lyrics');
  el.querySelector('p.on')?.classList.remove('on');
  const p = el.querySelector(`p[data-i="${idx}"]`);
  if (p) {
    p.classList.add('on');
    el.scrollTop = p.offsetTop - el.clientHeight / 2 + p.clientHeight / 2;
  }
}

// ---------------- イコライザー ----------------
function openEq() {
  const s = eq.settings;
  const bands = BANDS.map((f, i) => `
    <div class="eq-band">
      <span class="v" id="eqv${i}">${s.gains[i] > 0 ? '+' : ''}${s.gains[i]}</span>
      <input type="range" min="-12" max="12" step="1" value="${s.gains[i]}" data-band="${i}" aria-label="${f}Hz">
      <span class="f">${f >= 1000 ? `${f / 1000}k` : f}</span>
    </div>`).join('');
  const presets = Object.keys(PRESETS).map((n) => `<button class="chip ${n === s.preset ? 'on' : ''}" data-preset="${esc(n)}">${esc(n)}</button>`).join('');
  openSheet('イコライザー', `
    <label class="switch"><input type="checkbox" id="eqOn" ${s.enabled ? 'checked' : ''}> イコライザーを使う</label>
    <div class="eq-presets">${presets}</div>
    <div class="eq-bands">${bands}</div>
    <p class="small muted center">dB（−12〜+12）</p>
    <label>プリアンプ <span id="preV">${s.preamp} dB</span><input type="range" id="eqPre" min="-12" max="12" step="1" value="${s.preamp}"></label>
    <label class="switch"><input type="checkbox" id="eqClip" ${s.antiClip ? 'checked' : ''}> 音割れ防止（ブースト分だけ全体の音量を下げる）</label>
    <label class="switch"><input type="checkbox" id="eqNorm" ${s.normalize ? 'checked' : ''}> 音量の平準化（曲ごとの音量差を小さくする）</label>
    <p class="small muted">※ iPhone でイコライザーを使うと、ロック中の曲送りが止まることがあります。</p>`, 'eq');
  const c = $('#sheetContent');
  c.querySelector('#eqOn').onchange = (e) => { eq.setEnabled(e.target.checked); $('#cfgEq').checked = e.target.checked; };
  c.querySelectorAll('[data-band]').forEach((r) => {
    r.oninput = () => {
      const i = Number(r.dataset.band);
      eq.setBand(i, Number(r.value));
      c.querySelector(`#eqv${i}`).textContent = `${r.value > 0 ? '+' : ''}${r.value}`;
      c.querySelectorAll('[data-preset]').forEach((b) => b.classList.remove('on'));
    };
  });
  c.querySelectorAll('[data-preset]').forEach((b) => { b.onclick = () => { eq.setPreset(b.dataset.preset); openEq(); }; });
  c.querySelector('#eqPre').oninput = (e) => { eq.set('preamp', Number(e.target.value)); c.querySelector('#preV').textContent = `${e.target.value} dB`; };
  c.querySelector('#eqClip').onchange = (e) => eq.set('antiClip', e.target.checked);
  c.querySelector('#eqNorm').onchange = (e) => eq.set('normalize', e.target.checked);
}
$('#btnEq').onclick = openEq;

// ---------------- 設定 ----------------
async function renderSettings() {
  const logged = auth.isLoggedIn();
  $('#btnLogin').hidden = logged;
  $('#btnLogout').hidden = !logged;
  $('#cfgClientId').value = auth.authConfig.clientId;
  $('#cfgProxy').value = auth.authConfig.proxyUrl;
  $('#cfgEq').checked = eq.settings.enabled;
  $('#cfgCacheLimit').value = String(cache.cacheLimit.get());
  const root = getRoot();
  $('#rootInfo').textContent = root ? `${root.name}${library ? `（${library.tracks.length} 曲, ${new Date(library.scannedAt).toLocaleString('ja-JP')} にスキャン）` : ''}` : '未選択';
  const st = await cache.stats();
  $('#cacheInfo').textContent = `オフライン保存: ${st.pinnedCount} 曲 (${cache.formatBytes(st.pinnedSize)}) / 一時キャッシュ: ${st.tempCount} 曲 (${cache.formatBytes(st.tempSize)})`;
  if (logged) {
    $('#acctInfo').textContent = auth.isDevToken() ? '開発者トークンで接続中' : 'ログイン済み';
    try {
      const me = await box.me();
      $('#acctInfo').textContent = `${me.name}（${me.login}）${auth.isDevToken() ? ' · 開発者トークン' : ''}`;
    } catch (e) {
      if (!navigator.onLine) $('#acctInfo').textContent += '（オフライン）';
      else { $('#acctInfo').textContent = e.message; if (!auth.isLoggedIn()) renderSettings(); }
    }
  } else {
    $('#acctInfo').textContent = '未ログイン';
  }
}

$('#btnLogin').onclick = () => { try { auth.startLogin(); } catch (e) { toast(e.message); $('details').open = true; } };
$('#btnLogout').onclick = () => { auth.logout(); toast('ログアウトしました'); renderSettings(); };
$('#btnSaveCfg').onclick = () => {
  auth.authConfig.clientId = $('#cfgClientId').value.trim();
  auth.authConfig.proxyUrl = $('#cfgProxy').value.trim();
  toast('保存しました');
};
$('#btnDevToken').onclick = () => {
  const t = $('#cfgDevToken').value.trim();
  if (!t) return;
  auth.useDevToken(t);
  $('#cfgDevToken').value = '';
  toast('開発者トークンを設定しました');
  renderSettings();
};
$('#cfgEq').onchange = (e) => { eq.setEnabled(e.target.checked); };
$('#cfgCacheLimit').onchange = (e) => { cache.cacheLimit.set(Number(e.target.value)); cache.evict([player.currentId]).then(renderSettings); };
$('#btnClearCache').onclick = async () => { await cache.clearTemp(); toast('一時キャッシュを削除しました'); renderSettings(); };
$('#btnClearAll').onclick = async () => {
  if (!confirm('オフライン保存した曲も含めて全て削除しますか？')) return;
  await cache.clearAll();
  pinned = new Set();
  toast('削除しました');
  refreshLists();
  renderSettings();
};

function getRoot() {
  try { return JSON.parse(localStorage.getItem('bm.root')); } catch { return null; }
}

// Box のフォルダを辿って音楽フォルダを選ぶ
async function openFolderPicker(folderId = '0') {
  openSheet('音楽フォルダを選択', '<p class="muted">読み込み中…</p>', 'picker');
  try {
    const [folder, items] = await Promise.all([box.folder(folderId), box.folderItems(folderId)]);
    if (sheetKind !== 'picker') return;
    const crumbs = [...folder.path_collection.entries, { id: folder.id, name: folder.id === '0' ? 'すべてのファイル' : folder.name }];
    const folders = items.filter((i) => i.type === 'folder');
    const audioCount = items.filter((i) => i.type === 'file').length;
    $('#sheetContent').innerHTML = `
      <p class="small muted">${crumbs.map((c) => `<a href="#" data-f="${esc(c.id)}">${esc(c.id === '0' ? 'すべてのファイル' : c.name)}</a>`).join(' / ')}</p>
      <button class="chip primary" id="pickHere">「${esc(crumbs[crumbs.length - 1].name)}」を選ぶ</button>
      <p class="small muted">フォルダ ${folders.length} 個 · ファイル ${audioCount} 個</p>
      <ul class="list">${folders.map((f) => `<li data-f="${esc(f.id)}"><div class="main"><div class="t">📁 ${esc(f.name)}</div></div><span class="muted">›</span></li>`).join('')}</ul>`;
    $('#sheetContent').querySelectorAll('[data-f]').forEach((el) => {
      el.onclick = (e) => { e.preventDefault(); openFolderPicker(el.dataset.f); };
    });
    $('#pickHere').onclick = async () => {
      const root = { id: folder.id, name: crumbs[crumbs.length - 1].name };
      localStorage.setItem('bm.root', JSON.stringify(root));
      playlists.rootId = root.id;
      closeSheet();
      await rescan();
      playlists.sync().catch(() => {});
    };
  } catch (e) {
    $('#sheetContent').innerHTML = `<p>${esc(e.message)}</p>`;
  }
}
$('#btnPickRoot').onclick = () => {
  if (!auth.isLoggedIn()) return toast('先に Box にログインしてください');
  openFolderPicker(getRoot()?.id || '0');
};

let scanning = false;
async function rescan() {
  const root = getRoot();
  if (!root) return toast('音楽フォルダを選んでください');
  if (scanning) return;
  scanning = true;
  try {
    library = await scanLibrary(root, (p) => setStatus(`スキャン中 ${p.folders} フォルダ / ${p.tracks} 曲`));
    indexLibrary();
    toast(`${library.tracks.length} 曲が見つかりました`);
    refreshLists();
    renderSettings();
  } catch (e) {
    toast(`スキャン失敗: ${e.message}`);
  } finally {
    scanning = false;
    setStatus('');
  }
}
$('#btnRescan').onclick = rescan;

function indexLibrary() {
  trackMap = new Map((library?.tracks || []).map((t) => [t.id, t]));
}

// ---------------- 起動 ----------------
async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn(e));

  try {
    if (await auth.handleRedirect()) toast('Box にログインしました');
  } catch (e) {
    toast(e.message, 5000);
  }

  const [lib, metas, pins] = await Promise.all([loadLibrary(), idb.entries('meta'), cache.pinnedIds(), playlists.load()]);
  library = lib;
  indexLibrary();
  for (const [k, v] of metas) meta.set(k, v);
  pinned = pins;
  playlists.rootId = getRoot()?.id || null;

  renderModes();
  renderNowMeta();
  renderPlayState();

  if (!auth.isLoggedIn()) {
    showTab('settings');
    return;
  }
  if (!getRoot()) {
    showTab('settings');
    toast('音楽フォルダを選んでください');
    return;
  }
  showTab('library');
  if (!library || library.rootId !== getRoot().id) rescan();
  if (navigator.onLine) playlists.sync().catch(() => {});
}

// 別の端末での変更を取り込むため、アプリに戻ってきたら同期
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    eq.resume();
    if (auth.isLoggedIn() && navigator.onLine) playlists.sync().catch(() => {});
  }
});
window.addEventListener('online', () => { if (auth.isLoggedIn()) playlists.sync().catch(() => {}); });

init();
