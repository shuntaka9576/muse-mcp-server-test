# Muse Remote MCPで会議室を予約する

記事「MuseでAWS上のRemote MCP Server向けのCustom Connector作成を試す」の検証用サーバーです。AgentCore GatewayからLambdaを呼び出し、Aurora DSQLに保存した架空の会議室を検索・予約・キャンセルします。

## 構成

| 接続先                    | Gatewayの受信認証                             | Lambda・DBロール・スキーマ |
| ------------------------- | --------------------------------------------- | -------------------------- |
| `PublicGatewayUrl`        | `NONE`                                        | `booking_noauth`専用       |
| `AuthenticatedGatewayUrl` | Cognitoのアクセストークンを`CUSTOM_JWT`で検証 | `booking_auth`専用         |

`DcrProxyUrl`はLambda Web FunctionsのHTTPSエンドポイントです。Node.js 24から同梱したPythonを起動し、FastMCP OAuth ProxyがDCR・PKCE・Cognitoログインを処理します。登録情報と暗号化したトークンはDynamoDB、鍵はSecrets Managerに保存します。認証後はCognitoのアクセストークンで`AuthenticatedGatewayUrl`へ接続します。

ProxyのURL・CognitoのクライアントID・`AuthenticatedGatewayUrl`は、SSM Parameter（`/dev-muse-mcp/oauth-proxy/config`）からProxyが起動時に読みます。CognitoのコールバックURLにProxyのURLを使い、GatewayはそのクライアントIDを検証するため、Web Functionsの環境変数に渡すとCloudFormationで循環参照になるからです。

共通のLambdaコードを別々の関数・実行ロールで動かします。DSQLクラスターは共通ですが、各ロールには自身のスキーマだけを許可します。スキーマ名はLambdaの環境変数に固定し、ツール引数から変更できません。

| ツール                   | 引数                                  | 処理                                           |
| ------------------------ | ------------------------------------- | ---------------------------------------------- |
| `search_available_rooms` | `start_time`, `end_time`, `attendees` | 定員と空き状況による検索                       |
| `create_reservation`     | 上記 + `room_id`, `title`             | 予約を保存し、`reservation_id`を返す           |
| `list_reservations`      | `date`                                | 日本時間の指定日に重なる予約を取得             |
| `cancel_reservation`     | `reservation_id`                      | 指定予約を削除。削除済みなら`cancelled: false` |

Gatewayが公開する名前は`booking___search_available_rooms`などです。日時には秒・タイムゾーン付きISO 8601形式（例: `2026-10-29T14:00:00+09:00`）を使用します。終了時刻は含まず、予約時間は24時間以内、人数は1〜50人、件名は120文字以内です。業務上の拒否は`ok: false`と`error.code`で返すため、ツールを呼べたことだけで予約成功と判断しないでください。

デモデータは共有で、Cognito認証ありでもユーザーごとの予約所有者制御はありません。個人情報・実際の予定は入力しないでください。

## DSQLのデータと二重予約防止

各スキーマに以下のテーブルを作成します。

| テーブル         | 内容                                    | LambdaのDB権限               |
| ---------------- | --------------------------------------- | ---------------------------- |
| `rooms`          | 会議室ID・名前・定員                    | `SELECT`                     |
| `reservations`   | 予約ID・会議室ID・開始/終了・件名・人数 | `SELECT`, `INSERT`, `DELETE` |
| `booking_guards` | 会議室ごとの競合検知用カウンター        | `SELECT`, `UPDATE`           |

空き検索の後にINSERTするだけでは、同時予約を防げません。予約・取消では同じ会議室の`booking_guards`行を同一トランザクションで更新します。DSQLが競合を検知した場合（SQLSTATE `40001`）はトランザクション全体を再試行し、先に確定した予約を見て重複を拒否します。

Lambdaには対象クラスターの`dsql:DbConnect`のみを付与します。初期化・照合用のCLIは、AWS認証済みの実行者の`dsql:DbConnectAdmin`を使います。IAMトークンは接続の都度生成し、TLS証明書を検証します。

## ローカルの確認

Node.js 24、Bun 1.4.2、uvを使用します。`proxy:build`でLinux ARM64用Pythonと依存パッケージをZIPにまとめます。

```sh
bun install --frozen-lockfile
bun run proxy:build
bun run type-check
bun run test
bun run lint
```

## デプロイとデータ初期化

標準は`ap-northeast-1`、スタック名は`dev-muse-mcp-test`です。AWS認証済みのシェルで実行します。CDKのコマンドは`iac/aws`で実行し、プロファイルを指定する場合は`--profile PROFILE_NAME`を追加してください。

```sh
bun run proxy:build
cd iac/aws
bunx cdk diff
bunx cdk deploy --outputs-file ../../.local/outputs.json
cd ../..
bun run db:init --date 2026-10-29
```

CDK bootstrapが未実施なら、`iac/aws`で`bunx cdk bootstrap 'aws://ACCOUNT_ID/ap-northeast-1'`を先に実行します。リージョン・環境名を変える場合は、各CDKコマンドに同じ`-c stageName=experiment -c region=us-east-1`を渡します。

`cdk deploy`はIAMの変更を表示して承認を求めます。`proxy:build`で作ったZIPをWeb Functionsのコードとして使うため、Proxyのコードを変えたらデプロイ前にビルドし直します。

URL、DB接続先、Cognito設定などは`.local/outputs.json`に出力されます。`db:init`はスキーマ、テーブル、DBロール、IAMロールとの対応付けを作成し、両スキーマへ同じ初期データを投入します。日付省略時は日本時間の翌日です。既存予約を削除する処理はありません。

| 会議室                 | 定員 | 指定日の14:00〜15:00  |
| ---------------------- | ---- | --------------------- |
| さくら (`room-sakura`) | 2    | 空き（4人では候補外） |
| かえで (`room-kaede`)  | 4    | 空き                  |
| あおば (`room-aoba`)   | 8    | デモ用の既存予約あり  |

日付・出力ファイル・スタック名を変えた場合は、以降の検証にも合わせて渡します。

## 実サービスで検証する

```sh
bun run db:verify --date 2026-10-29
bun run mcp:test --date 2026-10-29
```

`db:verify`はAWS権限で両Lambdaを直接呼び出し、実際のDSQLの行を照合します。予約後に一覧へ載ること、候補から外れること、キャンセル後に候補へ戻ること、定員超過・重複予約の拒否、同時予約2件中1件だけの成功を確認します。検証実行者のIAMロールを各DBロールへ一時的に対応付け、そのDBロールで新規接続します。別スキーマの読み書きと会議室マスターへの書き込みがSQLSTATE `42501`で拒否されることを確認し、一時的な対応付けは終了時に解除します（DSQLでは`SET ROLE`を利用できません）。

`mcp:test`は認証なしのGatewayにStreamable HTTPで接続し、`initialize`・4ツールの検出・同じ予約シナリオを実行します。テストが作成した予約は終了時にキャンセルします。初期データの「かえで」が対象時刻に空いていることを前提とするため、Museでその時間を予約した後は先にキャンセルしてください。

結果はそれぞれ`.local/result-database.json`、`.local/result-public.json`へ保存します。Lambdaの専用CloudWatch Logsにもツール名・正規化した引数・結果を記録します。認証トークンは記録しません。

## Cognitoで認証する

Cognitoアプリクライアントはシークレットなしの認可コードフローです。ローカルクライアントはPKCEの`S256`を使います。Gatewayは署名・有効期限に加え、`client_id`、`scope`（`dev-muse-mcp/invoke`）、`token_use: access`を検証します。Gateway URLへの`aud`一致は設定していません。

セルフサインアップ、MFA、セルフサービスのパスワード回復は無効のため、検証ユーザーは管理者APIで作成します。パスワードは`openssl rand`で生成し、ポリシー（12文字以上、大文字・小文字・数字・記号）を必ず満たすよう先頭に`Aa1_`を付けます。

```sh
pool_id=$(jq -r '.["dev-muse-mcp-test"].UserPoolId' .local/outputs.json)
password="Aa1_$(openssl rand -base64 24 | tr -d '/+=')"
aws cognito-idp admin-create-user --region ap-northeast-1 \
  --user-pool-id "$pool_id" --username muse-demo --message-action SUPPRESS
aws cognito-idp admin-set-user-password --region ap-northeast-1 \
  --user-pool-id "$pool_id" --username muse-demo --password "$password" --permanent
echo "username: muse-demo"
echo "password: $password"
```

```sh
bun run mcp:test --auth --date 2026-10-29
```

トークンなし・不正トークンの拒否を確認した後、表示されたURLでCognitoへログインします。`http://localhost:8765/callback`で認可コードを受け取り、IDトークンの拒否とアクセストークンによる4ツールの実行を検証します。結果は`.local/result-authenticated.json`へ保存し、トークンはメモリ内だけで扱います。

## Museから接続する

`PublicGatewayUrl`を次のプロンプトに指定します。

```text
Create a Custom Connector for my remote MCP server.

Transport: Streamable HTTP
URL: <PublicGatewayUrl>

Please discover the four meeting room booking tools and test the connection.
```

続けて「2026年10月29日14時から1時間、4人で使える空き会議室を探して」と依頼します。予約・一覧・再検索・キャンセル・再検索を順に試し、Museの許可画面とDSQLの行を照合します。

認証ありは`DcrProxyUrl`を使用します。Museの操作は利用者が行います。

```text
Create a Custom Connector for my remote MCP server.

Name: custom.dev-muse-mcp-auth
Transport: Streamable HTTP
URL: <DcrProxyUrl>
Authentication: OAuth 2.0 Authorization Code with PKCE (S256)
Client registration: Dynamic Client Registration (DCR)

Discover the OAuth metadata, register the client, and guide me through Cognito login.
After login, discover the available tools and test the connection using read-only tools.
```

CognitoにはProxyの`/auth/callback`を登録済みです。Museのクライアント情報はProxyのDCRで登録します。リダイレクト先は`apps/oauth-proxy/proxy_app.py`の許可リストに制限しています。Museが別ドメインを返した場合は、実際のURIを確認して許可リストを更新します。

Proxyの公開URLでは、DCR登録・Cognitoログイン・PKCE・4ツールの取得・予約一覧・空き検索・トークン更新を確認しました。未認証・不正トークンは401です。結果は`.local/result-dcr-proxy.json`に保存し、一時ユーザーは削除しています。

## ツール定義と許可画面

GatewayのLambda用CloudFormation `ToolDefinition`には`annotations`フィールドがないため、今回は説明文に読み取り・予約確定・削除を明記します。`readOnlyHint`や`destructiveHint`を任意に変更する比較はこの構成では実装していません。実際の`tools/list`とMuseの許可画面は分けて記録します。

## 制限と削除

予約処理の各Lambdaは同時実行数2、タイムアウト30秒です。

```sh
cd iac/aws
bunx cdk destroy
```

検証用DSQLデータ、Cognitoユーザー、Lambdaログも削除します。`.local/`、CDK bootstrapのリソース、Web Functionsのコードを保存したS3バケットは残ります。

## 検証結果（2026年10月28日）

東京リージョンへのデプロイ後、2026年10月29日14:00〜15:00（Asia/Tokyo）を対象に以下を確認しました。

| 検証                                                              | 結果                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 認証なしGatewayの初期化・4ツール検出                              | 成功                                                                                  |
| Cognito認可コード＋PKCEでのログイン・認証ありGatewayの4ツール実行 | 成功（ローカルMCPクライアント）                                                       |
| トークンなし / 不正トークン / IDトークンでの`tools/call`          | HTTP 401 / 401 / 403                                                                  |
| 保護リソースメタデータ                                            | `WWW-Authenticate`の`resource_metadata`から取得でき、Cognitoのissuerと必要scopeを確認 |
| 定員・既存予約による検索                                          | 4人の候補は「かえで」のみ                                                             |
| 予約・一覧・候補からの除外・取消・候補への復帰                    | 両Gateway・両DBスキーマで成功                                                         |
| 重複予約 / 定員超過                                               | `ROOM_UNAVAILABLE` / `CAPACITY_EXCEEDED`で拒否                                        |
| 同時予約2件                                                       | 1件だけ成功、他方を拒否                                                               |
| 他方のスキーマの読み書き / 会議室マスターへの書き込み             | 両DBロールでSQLSTATE `42501`                                                          |
| 実際の`tools/list`の`annotations`                                 | 4ツールともフィールドなし                                                             |

実行証跡は`.local/result-public.json`、`.local/result-authenticated.json`、`.local/result-database.json`に保存しています。検証で作成した予約、一時Cognitoユーザー、一時的なDBロール対応付けは削除・解除し、初期データを残しています。

Museでは認証なしの6操作を確認済みです。認証ありのCustom Connector作成・OAuthログインは、利用者が`DcrProxyUrl`で検証します。

## 参照資料

- [DSQLのIAMとDBロール](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/using-database-and-iam-roles.html)
- [DSQLの競合制御](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-concurrency-control.html)
- [AgentCore GatewayのLambda入力形式](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-lambda.html)
- [Gatewayの受信認証](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-inbound-auth.html)
- [CognitoのPKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html)
