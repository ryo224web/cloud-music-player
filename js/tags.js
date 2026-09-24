// 曲情報（タグ）の読み取り
//  - MP3: ID3v2.2 / 2.3 / 2.4（タイトル・アーティスト・アルバム・ジャケット・歌詞）
//  - M4A/AAC: MP4 の ilst アトム（タイトル・アーティスト・アルバム・ジャケット・歌詞）
//  - FLAC: Vorbis Comment と PICTURE ブロック

export async function readTags(blob) {
  try {
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
      const size = syncsafe(head, 6) + 10;
      return parseID3(new Uint8Array(await blob.slice(0, size + 10).arrayBuffer()));
    }
    if (ascii(head, 4, 4) === 'ftyp') return parseMP4(blob);
    if (ascii(head, 0, 4) === 'fLaC') return parseFLAC(new Uint8Array(await blob.slice(0, 8 * 1024 * 1024).arrayBuffer()));
  } catch (e) {
    console.warn('タグの読み取りに失敗', e);
  }
  return {};
}

const syncsafe = (b, p) => (b[p] << 21) | (b[p + 1] << 14) | (b[p + 2] << 7) | b[p + 3];
const u32 = (b, p) => ((b[p] << 24) >>> 0) + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]);
const u24 = (b, p) => (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];
const ascii = (b, p, n) => String.fromCharCode(...b.subarray(p, p + n));

function latin1OrSjis(bytes) {
  // タグが「ISO-8859-1」と宣言していても中身が Shift_JIS のことが多い
  if (bytes.some((c) => c >= 0x80)) {
    try { return new TextDecoder('shift_jis', { fatal: true }).decode(bytes); } catch { /* latin1 にフォールバック */ }
  }
  return new TextDecoder('latin1').decode(bytes);
}

function decode(bytes, enc) {
  switch (enc) {
    case 1: return new TextDecoder('utf-16').decode(bytes); // BOM 付き
    case 2: return new TextDecoder('utf-16be').decode(bytes);
    case 3: return new TextDecoder('utf-8').decode(bytes);
    default: return latin1OrSjis(bytes);
  }
}

// 文字コードに応じた終端（NUL）位置を探す
function findTerm(b, from, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
  } else {
    for (let i = from; i < b.length; i++) if (b[i] === 0) return i;
  }
  return b.length;
}
const termLen = (enc) => (enc === 1 || enc === 2 ? 2 : 1);

function textFrame(d) {
  const enc = d[0];
  return decode(d.subarray(1), enc).replace(/\0.*$/s, '').trim();
}

function unsync(d) {
  const out = [];
  for (let i = 0; i < d.length; i++) {
    out.push(d[i]);
    if (d[i] === 0xff && d[i + 1] === 0x00) i++;
  }
  return Uint8Array.from(out);
}

function parseID3(b) {
  const out = {};
  const ver = b[3];
  const flags = b[5];
  let end = Math.min(10 + syncsafe(b, 6), b.length);
  let p = 10;
  if (ver < 4 && flags & 0x80) {
    b = unsync(b.subarray(0, end));
    end = b.length;
  }
  if (flags & 0x40) p += ver === 4 ? syncsafe(b, p) : u32(b, p) + 4;

  while (p + (ver === 2 ? 6 : 10) <= end) {
    let id, size, hdr, fflags = 0;
    if (ver === 2) {
      id = ascii(b, p, 3); size = u24(b, p + 3); hdr = 6;
    } else {
      id = ascii(b, p, 4); size = ver === 4 ? syncsafe(b, p + 4) : u32(b, p + 4); hdr = 10;
      fflags = b[p + 9];
    }
    if (!/^[A-Z0-9]{3,4}$/.test(id) || size <= 0) break;
    let d = b.subarray(p + hdr, Math.min(p + hdr + size, end));
    p += hdr + size;
    if (ver === 4) {
      if (fflags & 0x01) d = d.subarray(4); // データ長インジケータ
      if (fflags & 0x02) d = unsync(d);
    }
    switch (id) {
      case 'TIT2': case 'TT2': out.title = textFrame(d); break;
      case 'TPE1': case 'TP1': out.artist = textFrame(d); break;
      case 'TPE2': case 'TP2': out.albumArtist = textFrame(d); break;
      case 'TALB': case 'TAL': out.album = textFrame(d); break;
      case 'TRCK': case 'TRK': out.track = parseInt(textFrame(d), 10) || undefined; break;
      case 'TPOS': case 'TPA': out.disc = parseInt(textFrame(d), 10) || undefined; break;
      case 'APIC': case 'PIC': {
        if (out.picture) break;
        const enc = d[0];
        let q, mime;
        if (id === 'PIC') {
          mime = ascii(d, 1, 3).toUpperCase() === 'PNG' ? 'image/png' : 'image/jpeg';
          q = 4;
        } else {
          const e = findTerm(d, 1, 0);
          mime = ascii(d, 1, e - 1) || 'image/jpeg';
          if (!mime.includes('/')) mime = `image/${mime.toLowerCase()}`;
          q = e + 1;
        }
        q += 1; // 画像種別
        q = findTerm(d, q, enc) + termLen(enc);
        out.picture = new Blob([d.slice(q)], { type: mime });
        break;
      }
      case 'USLT': case 'ULT': {
        const enc = d[0];
        const q = findTerm(d, 4, enc) + termLen(enc);
        const text = decode(d.subarray(q), enc).replace(/\0+$/, '').trim();
        if (text) out.lyrics = text;
        break;
      }
    }
  }
  return out;
}

// ---- MP4 / M4A ----
async function parseMP4(blob) {
  const out = {};
  // moov は先頭か末尾にあるため、トップレベルのアトムを順に辿る
  let pos = 0;
  let moov = null;
  while (pos + 8 <= blob.size) {
    const h = new Uint8Array(await blob.slice(pos, pos + 16).arrayBuffer());
    let size = u32(h, 0);
    const type = ascii(h, 4, 4);
    if (size === 1) size = Number(new DataView(h.buffer).getBigUint64(8));
    else if (size === 0) size = blob.size - pos;
    if (size < 8) break;
    if (type === 'moov') {
      if (size > 64 * 1024 * 1024) break;
      moov = new Uint8Array(await blob.slice(pos, pos + size).arrayBuffer());
      break;
    }
    pos += size;
  }
  if (!moov) return out;

  const ilst = findPath(moov, 8, moov.length, ['udta', 'meta', 'ilst']);
  if (!ilst) return out;
  for (const [type, s, e] of children(moov, ilst[0], ilst[1])) {
    const data = children(moov, s, e).find(([t]) => t === 'data');
    if (!data) continue;
    const v = moov.subarray(data[1] + 8, data[2]);
    const text = () => new TextDecoder().decode(v).trim();
    switch (type) {
      case '\xa9nam': out.title = text(); break;
      case '\xa9ART': out.artist = text(); break;
      case 'aART': out.albumArtist = text(); break;
      case '\xa9alb': out.album = text(); break;
      case '\xa9lyr': out.lyrics = text(); break;
      case 'trkn': out.track = (v[2] << 8) | v[3] || undefined; break;
      case 'disk': out.disc = (v[2] << 8) | v[3] || undefined; break;
      case 'covr': {
        const typeCode = moov[data[1] + 3];
        out.picture = new Blob([v.slice()], { type: typeCode === 14 ? 'image/png' : 'image/jpeg' });
        break;
      }
    }
  }
  return out;
}

function children(b, start, end) {
  const list = [];
  let p = start;
  while (p + 8 <= end) {
    const size = u32(b, p);
    if (size < 8 || p + size > end) break;
    list.push([String.fromCharCode(...b.subarray(p + 4, p + 8)), p + 8, p + size]);
    p += size;
  }
  return list;
}

function findPath(b, start, end, path) {
  let range = [start, end];
  for (const name of path) {
    // meta は version/flags の 4 バイトを持つ
    const c = children(b, range[0], range[1]).find(([t]) => t === name);
    if (!c) return null;
    range = [c[1] + (name === 'meta' ? 4 : 0), c[2]];
  }
  return range;
}

// ---- FLAC ----
function parseFLAC(b) {
  const out = {};
  let p = 4;
  for (;;) {
    if (p + 4 > b.length) break;
    const last = b[p] & 0x80;
    const type = b[p] & 0x7f;
    const len = u24(b, p + 1);
    const d = b.subarray(p + 4, p + 4 + len);
    if (type === 4) {
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      let q = 4 + dv.getUint32(0, true);
      const n = dv.getUint32(q - 0, true);
      q += 4;
      const td = new TextDecoder();
      for (let i = 0; i < n && q + 4 <= d.length; i++) {
        const l = dv.getUint32(q, true);
        const s = td.decode(d.subarray(q + 4, q + 4 + l));
        q += 4 + l;
        const eq = s.indexOf('=');
        const k = s.slice(0, eq).toUpperCase();
        const v = s.slice(eq + 1);
        if (k === 'TITLE') out.title = v;
        else if (k === 'ARTIST') out.artist ??= v;
        else if (k === 'ALBUMARTIST') out.albumArtist = v;
        else if (k === 'ALBUM') out.album = v;
        else if (k === 'TRACKNUMBER') out.track = parseInt(v, 10) || undefined;
        else if (k === 'DISCNUMBER') out.disc = parseInt(v, 10) || undefined;
        else if (k === 'LYRICS' || k === 'UNSYNCEDLYRICS') out.lyrics = v;
      }
    } else if (type === 6 && !out.picture) {
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      let q = 4;
      const ml = dv.getUint32(q); q += 4;
      const mime = new TextDecoder().decode(d.subarray(q, q + ml)); q += ml;
      const dl = dv.getUint32(q); q += 4 + dl + 16;
      const pl = dv.getUint32(q); q += 4;
      out.picture = new Blob([d.slice(q, q + pl)], { type: mime || 'image/jpeg' });
    }
    p += 4 + len;
    if (last) break;
  }
  return out;
}
