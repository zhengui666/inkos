# InkOS 2

durable を唯一の実行基盤とする、コンテンツ制作と独立した配信のプラットフォームです。小説、短編、脚本、絵コンテ、インタラクティブ作品、翻訳、記事に対応します。CLI・TUI・Studio は同じプロジェクト runtime に接続します。投稿サイトは原稿制作の必須条件ではありません。

**Node 22.19.0 以上**、開発時は **pnpm 11.3.0** が必要です。この開発ブランチの npm 新バージョンは未公開です。

```sh
npm install -g @actalk/inkos
inkos init --lang ja
inkos up
inkos work create --id letters --title '夜の手紙' --locale ja --review '{"enabled":false}'
inkos write letters --file ./draft.txt --request-id imported-draft --wait
inkos tasks tree
inkos down
```

上記はモデルを呼び出さない原稿取り込みです。生成には `models list`、`models login <provider>`、`models set <provider> <model-id>` で設定します。公式 pi-ai の API Key／OAuth とモデルカタログを使用します。生成・画像サービスには料金が発生する場合があります。

一時停止はステップ境界で有効になる永続化された意図、キャンセルは SDK の abort です。画面を閉じてもバックグラウンド制作は続きます。保存済みバージョンは保持され、投稿済み作品の変更は明示的な `operation:update` が必要です。投稿・審査中・公開は別の状態として表示されます。

詳細は [操作と設定（英語）](docs/runtime.md)、[CLI リファレンス](packages/cli/README.md)、[アーキテクチャ](.opensdlc/architecture.md)、[実際のローカル検証と未実施の実サイト検証](.opensdlc/delivery.md) を参照してください。

今回の納品では実モデル呼び出し、アカウントログイン、実際の MegaNovel 作品作成・初回投稿・再起動時重複防止の実サイト検証は設定も実施もしていません。ローカル SDK／SQLite／ブラウザ検証は、文学的品質や実投稿成功の証明ではありません。

[AGPL-3.0-only](LICENSE)。過去の CHANGELOG にある旧コマンドは InkOS 2 の現行コマンドではありません。
