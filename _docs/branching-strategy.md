# Branching Strategy — TRYCLE bot (line-harness-oss fork)

このリポジトリは LH OSS (`Shudesu/line-harness-oss`) からの fork で、TRYCLE 専用改造を載せて運用しています。**横展開を見据えた branch 編集ルール**を以下に定めます。

> ⚠️ LH 本家の `CONTRIBUTING.md` は upstream sync の衝突を避けるため変更しません。TRYCLE 固有のルールは本ファイル (`_docs/branching-strategy.md`) で管理します。

---

## Branch 構成 (たった 2 本)

| branch | 用途 | 編集 |
|---|---|---|
| `main` | **唯一の正本**。全 tenant 共通の TRYCLE 製品コード。production deploy 対象 | ✅ 直接 commit & push |
| `upstream/main` | LH OSS 本家追従専用 remote (`Shudesu/line-harness-oss`)。直接触らない | ❌ 触らない (fetch のみ) |

---

## 編集ルール

- ✅ **main に直接 commit & push OK** (1 人開発のため)
- ✅ 短命 feature/* は OK (1〜3 日で main に merge して削除)
- ❌ **長命 feature/* は禁止** (LH 本家との差分が爆発する)
- ❌ tenant 固有 branch は作らない (差分は env vars + `tenants.settings` で吸収)

---

## Merge 戦略

短命 feature/* を main に取り込む時:

1. **Fast-forward 優先**: `git merge --ff-only feature/xxx`
2. ff 不可能なら **rebase + ff-merge**: `git rebase main` してから ff-merge
3. 試行錯誤の歴史を残したくないなら **強制リセット**: `git reset --hard feature/xxx && git push --force-with-lease`

merge commit (`--no-ff`) は **作らない** (linear history を保つ)。

---

## LH 本家 (upstream) 追従

月 1 で本家の更新を取り込む:

```bash
git fetch upstream
git merge upstream/main          # 衝突したら手動 resolve
pnpm test                        # 全 test pass を確認
pnpm exec vite build && pnpm exec wrangler deploy
git push origin main
```

衝突時の解消基準: **TRYCLE 改造を優先**。LH 本家の更新で挙動が変わる箇所はテストで検知。

---

## LH 本家への貢献 (差分縮小)

TRYCLE で作った機能で**汎用性が高い**ものは upstream に PR を投げ、取り込まれたら fork 側から削除して差分を縮小:

候補:
- Flex Message 50KB ガード
- Step ID 状態機械 (postback の連打/古ボタン/再発行制御)
- `reservation_done` 鮮度マーカー
- atomic claim パターン (`DELETE … RETURNING`)

---

## Tenant 差分の吸収方針

横展開時のテナント固有設定は **コードでなく設定で**:

| 項目 | 場所 |
|---|---|
| 店舗名・住所・営業時間 | `stores` テーブル |
| ブランド色・ロゴ・LINE OA ID | `tenants` テーブル |
| 税率・端数処理・通知ルール・権限 | `tenants.settings` (JSONB) |
| FAQ・同意書 | `faqs` / `consent_documents` テーブル |
| 工賃表 | `labor_master` テーブル |
| Feature flag | 環境変数 (例 `FEATURE_BARAKAN=true`) |

**`if (tenantId === 'trycle')` のような分岐は書かない**。

---

## Deploy

```bash
# 必ず vite build を先に実行 (wrangler deploy は build を skip する)
pnpm exec vite build && pnpm exec wrangler deploy
```

---

## 詳細は Notion へ

横展開ロードマップ・残課題は Notion ページ「マルチテナント拡大時の技術的残課題」を参照 (親 PJ ページ `353050ad-6a7e-8152-a04f-fbe481a32a12` 配下)。
