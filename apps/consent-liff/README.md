# consent-liff — 整備同意書 LIFF (Pkg1 案 B)

整備同意書を LINE 内 LIFF (WebView) で取得するアプリ。予約 LIFF (`apps/liff/`) とは
独立した別アプリ。Step 1 (文書表示 + 入力 + 同意チェック) → Step 2 (確認画面) →
Step 3 (完了) の 3 ステップ。

同意は clickwrap (能動チェック) 方式で取得し、確認画面の表示時刻
(`confirmation_screen_shown_at`) を証跡として保存する (電子契約法・APPI 上、
同意成立と証跡を補強する)。

## 構成

vite + React 19 + LIFF SDK + Tailwind v4。`apps/liff/` の構成を踏襲。

- `src/main.tsx` — LIFF init + App render
- `src/App.tsx` — Step 1 → Step 2 → Done の状態機械
- `src/components/` — ConsentForm / ConfirmStep / DoneStep / ConsentDocument
- `src/lib/` — liff-client (LIFF SDK wrap) / api-client (bot endpoint) / markdown (body_md render)

## 環境変数

| 変数 | 説明 |
|---|---|
| `VITE_LIFF_ID` | LINE Developers で発行した LIFF ID。`?liffId=...` クエリでも上書き可 |
| `VITE_API_BASE_URL` | bot worker の URL (例 `https://trycle-bot.example.workers.dev`)。同一オリジン配信なら空でも可 |

`.env.local` に設定する:

```
VITE_LIFF_ID=2000000000-xxxxxxxx
VITE_API_BASE_URL=https://your-bot-worker.workers.dev
```

## 開発手順

```bash
pnpm install
pnpm dev        # http://localhost:3003 (?liffId=... を付与)
pnpm build      # tsc -b && vite build → dist/
pnpm test       # vitest (Step 遷移・markdown render)
pnpm deploy     # pnpm build && wrangler pages deploy dist
```

LINE 外 (PC ブラウザ) では `liff.login()` リダイレクトが走るため、実機検証は
LINE アプリ内 or LIFF Inspector を使う。

## bot endpoint (apps/worker)

- `GET  /api/consent-document` — 最新の有効な同意書文面を返す
- `POST /api/consent-callback` — 同意内容を `consents` テーブルへ UPSERT

認証は LINE access_token を `Authorization: Bearer` で送り、bot 側が LINE Profile
API (`https://api.line.me/v2/profile`) で verify する。
