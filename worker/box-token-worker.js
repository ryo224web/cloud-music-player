// Box のトークン交換を中継する Cloudflare Worker（無料枠で動きます）
// Box の OAuth は client_secret が必須なので、秘密情報をブラウザに置かないためにここで交換する。
//
// 必要な環境変数（wrangler secret put で設定）:
//   BOX_CLIENT_ID      Box アプリの Client ID
//   BOX_CLIENT_SECRET  Box アプリの Client Secret
//   ALLOWED_ORIGINS    アプリを置いたサイトのオリジン（カンマ区切り）例: https://ryo224web.github.io
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes(origin)) return new Response('forbidden', { status: 403 });

    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: cors });

    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid_request' }, 400, cors); }

    const form = new URLSearchParams({ client_id: env.BOX_CLIENT_ID, client_secret: env.BOX_CLIENT_SECRET });
    const path = new URL(request.url).pathname;
    if (path === '/token' && typeof body.code === 'string') {
      form.set('grant_type', 'authorization_code');
      form.set('code', body.code);
    } else if (path === '/refresh' && typeof body.refresh_token === 'string') {
      form.set('grant_type', 'refresh_token');
      form.set('refresh_token', body.refresh_token);
    } else {
      return json({ error: 'invalid_request' }, 400, cors);
    }

    const res = await fetch('https://api.box.com/oauth2/token', { method: 'POST', body: form });
    return new Response(await res.text(), { status: res.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
