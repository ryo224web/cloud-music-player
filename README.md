# BoxMusic

Box に保存した MP3 などの音楽を、iPhone と Mac で再生するための Web アプリ（PWA）です。
App Store を通さず、iPhone のホーム画面に追加してアプリのように使えます。料金はかかりません。

## できること

- Box のフォルダを選ぶと、中の曲をまとめて一覧表示（サブフォルダも含む）
- 検索、全曲再生、シャッフル、リピート（全曲 / 1曲）、再生キュー（次に再生 / キューに追加）
- **プレイリストを Mac と iPhone で共有**：音楽フォルダ内の `boxmusic-playlists.json` に保存し、アプリを開くたびに自動で同期
- **オフライン再生**：曲単位またはプレイリスト単位で端末に保存。一度再生した曲も一時キャッシュに残る（上限は設定で変更）
- **イコライザー**：10 バンド、12 種類のプリセット、プリアンプ、音割れ防止、音量の平準化
- **歌詞表示**（再生位置に合わせてスクロールする同期歌詞にも対応）。取得元は次の順
  1. Box の曲と同じフォルダにある `曲ファイル名.lrc`
  2. 曲ファイルに埋め込まれた歌詞
  3. [LRCLIB](https://lrclib.net)（無料の歌詞データベース）
- ジャケット画像と曲情報の表示（MP3 / M4A / FLAC のタグを読み取り、Shift_JIS の古いタグにも対応）
- ロック画面やコントロールセンターからの操作
- 前回の再生位置を記憶

対応形式：MP3, M4A/AAC/ALAC, FLAC, WAV, AIFF（OGG/Opus は iPhone では再生できない場合があります）

## 注意点（iPhone）

- イコライザーをオンにすると、ロック中に次の曲へ進まないことがあります（iPhone の Safari 側の制限）。
  ロック中に聴くことが多いなら、設定でイコライザーをオフにしてください。
- 音質について：このアプリは元のファイルをそのまま再生します。元の音質より良くはなりませんが、
  イコライザーや音量の平準化で聴こえ方を調整できます。
- iPhone は長く使わないとオフライン保存したデータを消すことがあります。ホーム画面に追加して使うと消えにくくなります。

---

## セットアップ（最初の 1 回だけ、約 15 分）

Box のログインには「Box アプリの登録」と「トークンを中継する小さなプログラム」が必要です。
どちらも無料で、パソコン（Mac）から作業します。

### 1. アプリを GitHub Pages で公開する

1. GitHub のこのリポジトリで **Settings → Pages** を開く
2. **Source** を「Deploy from a branch」、ブランチを `main`、フォルダを `/ (root)` にして保存
3. 数分後、アプリの URL が決まります：
   `https://ryo224web.github.io/cloud-music-player/`
   （リポジトリを非公開のまま Pages を使うには GitHub の有料プランが必要です）

### 2. Box アプリを登録する

1. <https://app.box.com/developers/console> を開き **Create Platform App**
2. **Custom App** → 認証方式は **User Authentication (OAuth 2.0)** を選んで作成
3. **Configuration** タブで次を設定して保存
   - **OAuth 2.0 Redirect URI**：手順 1 のアプリの URL（最後の `/` まで同じにする）
   - **Application Scopes**：「Read all files and folders」と「Write all files and folders」にチェック
     （書き込みはプレイリスト用のファイルを保存するためだけに使います）
   - **CORS Domains**：`https://ryo224web.github.io`
4. 同じ画面の **Client ID** と **Client Secret** を控える

### 3. トークン中継（Cloudflare Worker）を作る

Box はログイン時に Client Secret を必要とするため、Secret をアプリに直接書かずに、中継用の小さなプログラムに持たせます。

1. <https://dash.cloudflare.com/> で無料アカウントを作成
2. Mac のターミナルで：
   ```sh
   cd worker
   npx wrangler login
   npx wrangler secret put BOX_CLIENT_ID      # 手順 2 の Client ID を貼り付け
   npx wrangler secret put BOX_CLIENT_SECRET  # 手順 2 の Client Secret を貼り付け
   npx wrangler deploy
   ```
3. 表示される URL（例：`https://cloud-music-player-token.xxxx.workers.dev`）を控える

※ `wrangler.toml` の `ALLOWED_ORIGINS` は、手順 1 のサイトのオリジンと同じにしてください。

### 4. 設定を書き込む

`js/config.js` に Client ID と Worker の URL を書いて、コミット・プッシュします。
（書かずに、アプリの **設定 → 接続設定** から各端末で入力することもできます）

### 5. 使い始める

1. Mac のブラウザでアプリの URL を開き、**設定 → Box にログイン**
2. **フォルダを選ぶ** で音楽が入っている Box のフォルダを選択（スキャンが始まります）
3. iPhone では Safari で同じ URL を開き、**共有ボタン → ホーム画面に追加**。
   追加したアイコンから開いて、同じようにログインします

### すぐに試したい場合

Box Developer Console のアプリ画面で **Developer Token** を発行し、
**設定 → 接続設定 → 開発者トークンでお試し** に貼り付けると、手順 3〜4 を飛ばして試せます（トークンは 60 分で切れます）。
この場合も手順 2 の CORS Domains の設定は必要です。

## ファイル構成

| パス | 内容 |
| --- | --- |
| `index.html`, `style.css` | 画面 |
| `js/app.js` | 画面の動き全体 |
| `js/player.js` | 再生キュー・シャッフル・リピート |
| `js/eq.js` | イコライザー |
| `js/lyrics.js` | 歌詞の取得と LRC の解析 |
| `js/tags.js` | 曲のタグ（ID3 / MP4 / FLAC）の読み取り |
| `js/box.js`, `js/auth.js` | Box API とログイン |
| `js/library.js`, `js/playlists.js` | ライブラリのスキャンとプレイリストの同期 |
| `js/cache.js`, `js/db.js` | オフライン保存（IndexedDB） |
| `sw.js` | オフラインでもアプリを起動できるようにする |
| `worker/` | トークン中継（Cloudflare Worker） |
