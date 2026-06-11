# AI-Plantgraphy3 仕様書（案 v0.1 / 2026-06-10）

## 1. コンセプト

スマホのDiscordに植物写真を投げるだけで、

1. すぐに種類の同定結果がDiscordに返信され（Stage 1）、
2. あとから観察記録と図鑑がGitHub Pagesの非公開図鑑サイトに自動公開される（Stage 2）

「Discord完結型・植物図鑑ボット」。

- AI-Plantgraphy の「PWA + 自宅FastAPI + Tailscale」構成を「Discord bot + 静的サイト自動publish」に置き換える
- multicli-discord-bridge は直接使わないが、仕組み（allowlistガード、添付保存、PTY経由のCLI実行、返信分割）を流用する
- 図鑑・観察の生成内容は AI-Plantgraphy の出力契約・データモデルに準拠する

## 2. 検証済みの技術事実（2026-06-10 実機確認）

Antigravity CLI（`agy.exe`）の非対話呼び出しを実機検証した結果:

| 項目 | 確認結果 |
|---|---|
| 実体パス | `C:\Users\sgmxk\AppData\Local\agy\bin\agy.exe` |
| 非対話モード | `agy -p "<プロンプト>"`（`--print`、デフォルトtimeout 5分、`--print-timeout`で変更可） |
| **重要: 出力先** | `-p` でも**TUI描画でコンソールに直接出力**するため、パイプ/リダイレクトでは何も取れない。**PTY（擬似端末）経由で起動して画面出力を取得する必要がある**（multicliと同じ`@lydell/node-pty`で動作確認済み） |
| 画像の渡し方 | プロンプト先頭に `@C:\絶対パス\image.jpg` を書くと**メディア添付**として渡る。`ReadFile`ツール経由（パスだけ書く方式）はJPEGで `INVALID_ARGUMENT (400)` になるため不可 |
| 権限フラグ | `@`添付方式ならツール承認が発生せず、`--dangerously-skip-permissions` **不要** |
| 所要時間 | 起動〜JSON返答まで **約12〜16秒**（実写真の同定で15.7秒、出力契約どおりのJSONが1発で返った） |
| モデル | 既定 "Gemini 3.5 Flash (High)"。`--model` で変更可 |
| PTY設定 | cols を大きめ（400）にして JSON が画面幅で折り返されるのを防ぐ。ANSIエスケープ除去が必要 |

検証スクリプト: `C:\Users\sgmxk\Desktop\AI\tmp\agy-pty-test.js`

## 3. 全体フロー

```
スマホ(Discord) ──画像1〜3枚+メモ──▶ Discord Bot (Node.js常駐, 自宅PC)
                                        │ 添付を data\incoming\msg-{id}\ に保存
                                        ▼
                          [Stage 1] agy -p (PTY経由, @画像添付)
                          同定プロンプト → 厳格JSON
                                        │
        ◀── 即返信(約20秒): 種名・学名・確度・候補 ──┘
                                        │
                          [Stage 2] agy -p 2回目(非同期)
                          観察記録テキスト(毎回) + 図鑑解説(新種のみ)
                                        │
                          ローカル正本(data\)更新
                          → 暗号化publish(docs\) → git commit & push
                                        ▼
        ◀── 完了通知: 図鑑URL ── GitHub Pages 自動デプロイ
```

## 4. コンポーネント構成

すべて Node.js（言語は確定。PTYが必須要件になったため、multicliと同じ
`discord.js` + `@lydell/node-pty` の組み合わせをそのまま参考実装にできる）。

| コンポーネント | 役割 | 流用元 |
|---|---|---|
| Discord Bot | 添付受信・保存、allowlist、リアクション進捗、返信分割 | multicliの添付保存・ガードの仕組み |
| Agy Runner | PTYで `agy -p "@画像 プロンプト"` を起動、ANSI除去、JSON抽出・検証、失敗時1回だけ厳格再生成 | AI-Plantgraphy `gemini_cli.py` の方針 + 今回の検証結果 |
| プロンプト | 同定用 / 観察・図鑑用 の2ファイル | AI-Plantgraphy output-contract 準拠 |
| Publisher | 正本JSON・画像を**AES-GCM暗号化**してPages公開ディレクトリへ書き出し、git commit→push | 新規（§6） |
| 図鑑Viewer | GitHub Pages上の静的SPA。初回のみパスワード入力→以後localStorageの鍵で自動復号 | AI-Plantgraphy-PWAの画面構成を簡略化 |

実行モデル: リクエストごとに agy プロセスを1回spawnして終了を待つ。
キューで直列実行（同時1件）。PTYの常駐セッションは持たない。

## 5. 2段階解析

### Stage 1: 種類の特定（速度優先・目標 約20秒で返信）

1. 許可ユーザーが専用チャンネルに画像投稿（1〜3枚、本文はメモ扱い）
2. Bot が 🔍 リアクション → 画像保存 → agy 起動
3. 出力契約は AI-Plantgraphy `output-contract.md` をそのまま使用:
   `common_name_ja` / `scientific_name` / `confidence` / `candidates`(最大3) /
   `visible_features`(最大5) / `uncertainty_notes`
4. Discordへ即返信（例）:
   > 🌿 **ソメイヨシノ** (*Cerasus × yedoensis*) 確度 90%
   > 候補: サトザクラ 8% / ヤマザクラ 2%
   > 特徴: 満開の淡いピンクの花、…
5. JSON崩れ→厳格再生成1回→失敗なら ❌ + エラー返信（画像は保持、`!retry` で再実行可）

### Stage 2: 観察・図鑑生成と公開（品質優先・非同期）

1. Stage 1 返信直後にバックグラウンド続行（📝 リアクション = 生成中）
2. agy 2回目呼び出し。1コールで以下を生成:
   - `observation_text`: 観察記録の文章（毎回。同定結果+visible_features+ユーザーメモ+日付を渡す。150字以内）
   - 新種（学名スラッグが`plants.json`に未登録）のときだけ追加で:
     `basic_profile_text` / `visual_appeal_text` / `care_notes`（各120字以内、AI-Plantgraphy §11準拠）
3. 既存種なら図鑑解説はスキップし観察履歴に追記のみ（AI-Plantgraphyのルール踏襲）
4. 画像を長辺1280pxに圧縮（sharp使用。メタデータ=EXIF/GPSは自動で剥がれる）
5. 正本更新 → 暗号化publish → `git commit` → `git push`
6. push成功後、**新規メッセージ**で完了通知（編集でなく新規送信＝スマホ通知が鳴る）:
   > ✅ 図鑑を更新しました → https://harunamitrader.github.io/AI-Plantgraphy3/#/plants/cerasus-yedoensis

## 6. 非公開閲覧方式（GitHub Pages + クライアントサイド暗号化）

要件: GitHub Pagesベース / 画像・JSONもパスワードなしでは見えない / パスワード入力は端末ごとに初回1回だけ。

### 仕組み

- **公開されるのは暗号文だけ**。Publisherが publish 時に全データを暗号化する:
  - `site/data/plants.json.enc`、`observations.json.enc`、`images/*.jpg.enc`
  - 方式: AES-256-GCM。鍵はパスワードから PBKDF2-SHA256（イテレーション60万回、saltは`site/meta.json`に平文で同梱）で導出
  - 鍵確認用の小さな `check.enc`（既知文字列の暗号文）も置く
- **Viewer（静的SPA、これ自体は平文で公開）**:
  1. 初回アクセス時にパスワード入力画面
  2. WebCrypto でパスワード→鍵導出 → `check.enc` の復号成功で検証
  3. 導出済みの**鍵**（パスワードではない）を `localStorage` に保存 → 以後は入力不要で自動復号
  4. `*.enc` を fetch → ブラウザ内で復号。画像は Blob URL で表示
- リポジトリは public でも写真・観察データは読めない（HTML/JSは公開されるが中身は図鑑の器だけ）

### 制約（了承事項）

- パスワードを知る人は誰でも復号できる。共有相手の「個別解除」はできない（パスワード変更=全ファイル再暗号化publishで対応。Publisherに `republish --rekey` を用意）
- 暗号文はダウンロード可能なので、オフライン総当たりに耐えるよう**強めのパスワード**（12文字以上推奨）+ 高イテレーションPBKDF2とする
- 庭の植物写真という脅威モデルには十分

## 7. データモデル

ローカル正本（平文、`data\`、gitignore対象）と公開物（暗号化済み、`site\data\`）の2層。
DBは持たず、JSON 2ファイル + 画像フォルダが正本。git履歴が監査ログを兼ねる。

```jsonc
// plants.json（図鑑）
{
  "cerasus-yedoensis": {            // id = 学名スラッグ
    "common_name_ja": "ソメイヨシノ",
    "scientific_name": "Cerasus × yedoensis",
    "basic_profile_text": "…",      // 120字以内
    "visual_appeal_text": "…",      // 120字以内
    "care_notes": "…",              // 120字以内
    "cover_image": "images/obs-20260610-xxxx-1.jpg",
    "observation_ids": ["obs-20260610-xxxx"]
  }
}

// observations.json（観察記録）
{
  "obs-20260610-xxxx": {
    "plant_id": "cerasus-yedoensis",
    "observed_at": "2026-06-10T14:30:00+09:00",
    "images": ["images/obs-20260610-xxxx-1.jpg"],
    "confidence": 0.9,
    "candidates": [...],            // Stage1の結果そのまま
    "visible_features": [...],
    "uncertainty_notes": "…",
    "user_memo": "Discord本文",
    "observation_text": "…"         // Stage2生成、150字以内
  }
}
```

## 8. Discord UX

- 専用チャンネル1つ（`.env` の `PLANT_CHANNEL_ID` に固定）。multicliのslotチャンネルとは別に新設
- リアクションで状態表示: 🔍 同定中 → 📝 図鑑生成中 → ✅ 完了 / ❌ 失敗
- コマンド（multicli風の `!` プレフィックス）:
  - `!retry` … 直前の失敗メッセージを再処理
  - `!status` … キュー状況・最終publish時刻
  - `!list` … 図鑑の登録種一覧（名前のみ）
- 同定結果への訂正: 結果返信に対して `!fix アジサイ` と返信すると種名を上書きしてStage 2をやり直す（v1ではこれだけ。確認待ちUIは作らない）

## 9. セキュリティ

- `.env`: `DISCORD_BOT_TOKEN` / `ALLOW_USER_IDS` / `ALLOW_GUILD_ID`（1guild固定） / `PLANT_CHANNEL_ID` / `SITE_PASSWORD`
- 添付は画像MIME（jpeg/png/webp/heic）のみ、1メッセージ最大3枚・合計10MB
- agy は `@`添付 + 通常権限で実行（`--dangerously-skip-permissions` は使わない）
- 元画像のEXIF（GPS含む）はpublish時に除去
- `data\` と `.env` はコミットしない

## 10. リポジトリ構成

```
AI-Plantgraphy3\
  bot\
    src\
      index.js          # Discord bot本体・キュー
      agy-runner.js     # PTY起動・ANSI除去・JSON抽出
      publisher.js      # 暗号化publish + git push
      prompts\
        identify.md     # Stage1（output-contract準拠）
        enrich.md       # Stage2（観察+図鑑）
    package.json
  site\                 # GitHub Pages 公開ディレクトリ
    index.html          # Viewer SPA（平文）
    app.js / style.css
    meta.json           # salt等
    data\               # *.enc（Publisherが生成）
    images\             # *.enc
  data\                 # ローカル正本（gitignore）
    plants.json
    observations.json
    images\
    incoming\
  docs\
    SPECIFICATION.md    # 本書
  .env.example
  .gitignore
```

GitHub Pages は `master` ブランチの `site\` を公開対象に設定（または `docs\` 配下に
viewer を置く構成でも可。実装時に Pages の設定制約に合わせて確定）。

## 11. 実装計画（[手順] → [検証]）

### Phase 1: scaffold + Agy Runner
- [手順] リポジトリ作成、`agy-runner.js` 実装（PTY起動、cols=400、ANSI除去、JSON抽出、1回リトライ、タイムアウト）
- [検証] 実写真3枚で単体実行し、出力契約どおりのJSONが3/3で返る。所要時間が各20秒以内

### Phase 2: Discord Bot + Stage 1
- [手順] bot実装（allowlist、添付保存、キュー、🔍リアクション、同定結果返信）。Discord Developer PortalでBot新規作成、専用チャンネル作成
- [検証] スマホのDiscordから実写真を送信し、約20秒で種名返信が届く。許可外ユーザー・画像なしメッセージ・4枚以上が正しく拒否される

### Phase 3: Stage 2 生成 + ローカル正本
- [手順] `enrich.md` プロンプト実装、新種判定、plants.json / observations.json 更新、画像圧縮
- [検証] 新種→図鑑+観察が生成される。既知種2回目→観察のみ追記され図鑑解説が再生成されない。文字数上限が守られる

### Phase 4: 暗号化Publisher + Viewer + GitHub Pages
- [手順] AES-GCM暗号化publish、git push自動化、Viewer SPA（パスワード入力→鍵localStorage→一覧/詳細表示）、Pages有効化
- [検証] (a) 別ブラウザ（シークレット）でURL直叩き→ `*.enc` とviewerしか取得できず写真・データが読めない (b) パスワード入力後に図鑑・観察・画像が表示される (c) 再訪時に入力不要 (d) 誤パスワードが拒否される

### Phase 5: 運用ガード
- [手順] エラー時のDiscord通知、`!retry` / `!status` / `!fix`、bot常駐化（起動スクリプト+デスクトップショートカット、multicli方式）
- [検証] agy失敗・git push失敗を意図的に起こし、❌通知と`!retry`復旧を確認

## 12. 注意

- AIの植物判定は間違うことがある。安全に関わる用途（食用・毒性判断）ではAI結果だけを信じない（AI-Plantgraphyと同じ注意書きをViewerにも表示）
- agy のレートリミット・利用規約上の自動実行可否は運用しながら確認（1観察=2コール程度なので負荷は小さい）
