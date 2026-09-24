// Box OAuth 2.0
// Box のトークン交換には client_secret が必要なため、ブラウザに秘密情報を置かず
// 小さな中継（worker/box-token-worker.js）経由で交換・更新する。
import { CONFIG } from './config.js';

const TOKEN_KEY = 'bm.token';

export class AuthError extends Error {}

export const authConfig = {
  get clientId() { return localStorage.getItem('bm.clientId') || CONFIG.BOX_CLIENT_ID; },
  set clientId(v) { v ? localStorage.setItem('bm.clientId', v) : localStorage.removeItem('bm.clientId'); },
  get proxyUrl() { return (localStorage.getItem('bm.proxy') || CONFIG.TOKEN_PROXY_URL).replace(/\/+$/, ''); },
  set proxyUrl(v) { v ? localStorage.setItem('bm.proxy', v) : localStorage.removeItem('bm.proxy'); },
};

export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

function load() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY)); } catch { return null; }
}
function save(t) { localStorage.setItem(TOKEN_KEY, JSON.stringify(t)); }

export function isLoggedIn() { return !!load(); }
export function isDevToken() { return !!load()?.dev; }
export function logout() { localStorage.removeItem(TOKEN_KEY); }

export function useDevToken(token) {
  save({ access_token: token.trim(), dev: true, expires_at: Date.now() + 55 * 60 * 1000 });
}

export function startLogin() {
  if (!authConfig.clientId || !authConfig.proxyUrl) {
    throw new AuthError('設定画面で Client ID とトークン中継 URL を入力してください');
  }
  const state = crypto.getRandomValues(new Uint32Array(4)).join('-');
  sessionStorage.setItem('bm.state', state);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: authConfig.clientId,
    redirect_uri: redirectUri(),
    state,
  });
  location.href = `https://account.box.com/api/oauth2/authorize?${q}`;
}

function store(json) {
  if (!json.access_token) throw new AuthError(json.error_description || json.error || 'トークン取得に失敗しました');
  save({
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + ((json.expires_in || 3600) - 120) * 1000,
  });
}

async function callProxy(path, body) {
  const res = await fetch(authConfig.proxyUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new AuthError(json.error_description || json.error || `トークン中継エラー (${res.status})`);
  return json;
}

// OAuth のリダイレクトで戻ってきたときに呼ぶ。ログインを処理したら true。
export async function handleRedirect() {
  const p = new URLSearchParams(location.search);
  const code = p.get('code');
  const error = p.get('error');
  if (!code && !error) return false;
  history.replaceState(null, '', redirectUri());
  if (error) throw new AuthError(p.get('error_description') || error);
  const expected = sessionStorage.getItem('bm.state');
  sessionStorage.removeItem('bm.state');
  if (!expected || expected !== p.get('state')) throw new AuthError('ログイン状態の検証に失敗しました。もう一度お試しください');
  store(await callProxy('/token', { code, redirect_uri: redirectUri() }));
  return true;
}

let refreshing = null;
export function refresh() {
  if (!refreshing) {
    refreshing = (async () => {
      const t = load();
      if (!t) throw new AuthError('ログインしてください');
      if (t.dev) { logout(); throw new AuthError('開発者トークンの期限が切れました'); }
      try {
        store(await callProxy('/refresh', { refresh_token: t.refresh_token }));
      } catch (e) {
        // リフレッシュトークンが無効（60日未使用など）ならログアウト扱い
        if (e instanceof AuthError) logout();
        throw e;
      }
      return load().access_token;
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

export async function getToken() {
  const t = load();
  if (!t) throw new AuthError('ログインしてください');
  if (t.dev || Date.now() < t.expires_at) return t.access_token;
  return refresh();
}
