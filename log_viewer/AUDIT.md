# ログビューア監査記録

## 結論

提供された単一HTMLは、画面構成の参考資料としては有用だが、実装の土台としては採用しない。現行の `DATA.CSV` / `EVENT.CSV` は基本的な解析に十分な情報を持つ一方、機種識別、再起動境界、時刻、SD状態の意味に曖昧さがある。そのため本ビューアは、現行3.6形式を「互換入力」として厳格に検査し、異常を黙って補正しない方針とする。

## 今回実装した対策

- Vite＋Reactの独立した静的サイトとし、既存のPython API依存通信コンソールから分離した。CSV解析と検証はWeb Workerで実行する。
- v3.6では機種を自動確定せず、Triton-3／UmiBotを利用者が明示選択する。値の傾向による推定は参考表示だけに使う。
- RFC 4180相当の引用、BOM、CRLF、引用内改行を扱い、列数不一致・途中ヘッダー・未閉鎖引用・非有限値・範囲外値は行番号付きで隔離または警告する。
- ファイル順のまま再起動とuint32 `millis()`周回を判定し、表示用の単調時系列へ変換する。EVENTとDATAは統合し、一方しかない場合も縮退表示する。
- 1ファイル32 MiB、250,000行、1セル8,192文字を上限とし、連続再読込時は前のWorkerを終了できる。グラフは描画点を上限内へ間引く。
- CSV値はReactのテキストノードとしてのみ描画し、外部地図・CDN・解析サービスを使わない。CSP、ローカル処理表示、キーボード操作、表形式のグラフ代替を含めた。
- 両機種の正常／敵対的CSVを同梱し、BOM・引用・破損・センサー差・再起動・millis周回・20万行をNode標準テストで再現する。

## 提供HTMLを採用しなかった理由

1. 添付ファイルは1,027行目の `Chart.prototype.onDow... (43 KB left)` で物理的に途切れている。`</script>`、`</body>`、`</html>` もなく、構文上実行できない。欠落部分にはファイル読込、DOM描画、地図読込等が含まれる可能性があり、XSSや外部通信の完全監査もできない。
2. 添付HTMLの説明は「弁開放中はDATA行がほぼない」とするが、Standalone版はセンサー更新直後に500 ms間隔で、弁開放中と完了後も記録する設計である（`Triton-3-Standalone/Triton-3-Standalone.ino:346-360`、`UmiBot-Standalone/UmiBot-Standalone.ino:315-329`）。
3. 温度表示をTSYS01とMS5837の独立比較として固定しているが、UmiBotはMS5837温度を `water_c` と `press_c` の両方へ格納する（`UmiBot-Standalone/UmiBot-Standalone.ino:574-579`、`:796-800`）。同じ説明・警告規則を両機種へ適用できない。
4. 添付HTMLのCSVパーサーは、列数不一致、途中で切れた行、重複ヘッダー、閉じていない引用符、引用符内改行、`Infinity` 等を行番号なしで受理または `null` 化する。さらに生の順序を検査する前に `ms` でソートするため、再起動境界を破壊する。
5. Canvas中心で、ズーム、ホバー、イベント行ジャンプ、ファイルドロップがマウス前提である。代替テキスト、キーボード操作、ライブ通知、フォームラベルも不足している。
6. 「通信は一切行わない」という説明と、OpenStreetMapのオンライン表示が両立していない。CSV処理がローカルでも、タイル取得を行えば閲覧地点が外部へ伝わり得る。

## 現行3.6ログの正確な意味

両ファームウェアは `v=3.6` と同じファイル名を使用する（`Triton-3-Standalone/Triton-3-Standalone.ino:174-176`、`UmiBot-Standalone/UmiBot-Standalone.ino:118-120`）。DATAは30列、EVENTは20列である。

```text
DATA:  v,seq,ms,date,time,type,state,phase,plan,cycle,elapsed,remain,
       water_c,press_mbar,depth_m,max_m,press_c,lat,lng,alt,sat,gps,
       vinj,vexh,sd,last_seq,last_result,pc_age,err,msg

EVENT: v,seq,ms,date,time,event,state,phase,wireless_seq,cmd,result,plan,
       crc,src,depth_m,threshold_m,water_c,vinj,vexh,msg
```

以下では、`Triton:n` は `Triton-3-Standalone/Triton-3-Standalone.ino:n`、`UmiBot:n` は `UmiBot-Standalone/UmiBot-Standalone.ino:n` を指す。ヘッダーの根拠は `Triton:857-862`、`UmiBot:775-780`。主な意味は次のとおり。

| 項目 | 実際の意味・制約 |
|---|---|
| `seq` | DATA/EVENT共通の起動内連番。各ファイル単独では欠番が正常（`Triton:799-830`、`UmiBot:724-752`）。起動ごとに0へ戻る。 |
| `ms` | Arduino `millis()` の起動後ミリ秒。絶対時刻ではなく、32 bit環境では約49.7日で周回する。 |
| `date`,`time` | RTC値。GPS同期前は未校正・古い可能性があり、タイムゾーン列がない。並び順の唯一の根拠にしてはならない。 |
| `state` | Standaloneで使用する値は `0=SAFE/IDLE`、`2=RUNNING`、`3=COMPLETED`（`Triton:178-180`、`UmiBot:148-150`）。 |
| `phase` | `0=IDLE, 1=PREP, 2=EXH, 3=DESC, 4=WAIT, 5=INJ, 6=ASC, 7=DONE`。Standaloneはエラー用phase 8を出力しない。 |
| `cycle` | 現在までの完了サイクル数。最初の実行中は0で、ASC完了時に加算される（`Triton:642-697`、`UmiBot:589-636`）。有限実行後の継続DATAは増加後の値なので、新しい実行サイクルと解釈してはならない。 |
| `elapsed`,`remain` | 現在phaseの経過秒・残り秒。単位名が列名に含まれていない。 |
| `max_m` | 起動後の最大深度。サイクルごとにはリセットされない。 |
| `lat`,`lng`,`alt`,`sat`,`gps` | GPS位置、標高m、衛星数、位置fix有無。`gps=0` の座標は使用しない。 |
| `vinj`,`vexh` | 注入弁・排気弁の開状態。通常は同時に1にならない。EVENTは各イベント時点のスナップショット。 |
| `err` | Standaloneが出す既知bitは `0x0002=SD_WRITE`、`0x0004=TEMP_SENSOR`、`0x0008=DEPTH_SENSOR`、`0x0400=SENSOR_STALE`（`Triton:191-195`、`UmiBot:161-164`）。未知bitは消さずに表示する。 |
| `last_seq`,`last_result`,`pc_age` | Standaloneでは未対応だが `0,0,255` を出す（`Triton:898-900`、`UmiBot:809-811`）。実測値として表示しない。 |
| EVENTの無線関連列 | `wireless_seq,cmd,result,crc,src` はStandaloneでは `NA`。 |

### 機種ごとの差

| 項目 | Triton-3 Standalone | UmiBot Standalone |
|---|---|---|
| `water_c` | 独立TSYS01水温。妥当範囲は `-10 < t < 60` ℃（`Triton:575-598`）。 | MS5837内蔵温度を水温相当として格納（`UmiBot:574-579`）。 |
| `press_c` | MS5837内蔵温度。`water_c` と独立。 | `water_c` と同じ値で、独立測定ではない。 |
| 深度妥当範囲 | `-1..100 m`（`Triton:616-627`）。 | `-5..300 m`（`UmiBot:558-570`）。 |
| センサー故障 | TSYS01だけの故障では `water_c=NA`、`0x0004`。MS5837故障では圧力・深度・`press_c` がNA。 | MS5837故障で圧力・深度・両温度列がNAになり、`0x0008` / `0x0400` を使用する。独立温度センサー故障とは扱わない。 |
| `sd` | `sdReady && sdWriteOk`。現在行を書き込む前の状態を記録する（`Triton:897`）。 | `sdReady` のみで、直前の書込成否を表さない（`UmiBot:808`）。 |
| BOOT時のEVENT `plan` | 常に設定済みPLAN_ID。 | BOOTでは0を欠損のsentinelとして `NA` にする。 |

同じ3.6・同じ列名で `sd` と温度の意味が異なるため、CSVのみから機種を断定してはならない。旧形式では利用者の機種選択またはフォルダ由来の明示情報が必要である。

### 現行形式の構造的リスク

- ファイル名は常に `DATA.CSV` / `EVENT.CSV` で、既存ファイルへ追記する一方、`seq`、`ms`、`cycle` は再起動でリセットされる。読込時はファイル順を保持し、`BOOT`、seq/ms回帰、RTC状況から起動単位へ分割してから解析する。
- ファームウェアは既存の非空ファイルに新しいヘッダーを追記しない（`Triton:463-485`、`UmiBot:425-452`）。将来列が変わっても同名ファイルへ混在し得る。
- `msg` 等はCSV引用・エスケープなしで出力される（`Triton:905-930`、`UmiBot:816-835`）。現在の固定文字列はカンマを含まないが、形式として保証されていない。
- 書込に失敗した行自身はSDへ残らない。復旧後の `err` で直前の失敗を推定できる場合はあるが、欠落件数を正確には復元できない。
- EVENTが一部だけ存在する場合、EVENTだけを絶対視すると欠落区間を「正確な弁区間」と誤表示する。DATAとEVENTを統合し、矛盾・欠落を警告する必要がある。

## 敵対的ダミーデータ／試験マトリクス

| ID | 入力・攻撃条件 | 合格条件 |
|---|---|---|
| H-TR | Triton正常2サイクル、500 ms DATA、全phase/弁EVENT、GPS fix | 温度2系列を独立表示し、phase・弁・最大深度・完了サイクル数が一致する。 |
| H-UM | UmiBot正常2サイクル | MS5837温度を1測定源として説明し、同値2列を独立センサー比較しない。 |
| S-TR | TSYS01のみ故障、MS5837のみ故障、stale復旧 | NAと既知err bitを正しく区別し、正常系列を巻き添えで非表示にしない。 |
| S-UM | MS5837故障／範囲外／復旧 | 深度・圧力・両温度列の関係を保ち、TEMP_SENSOR故障を捏造しない。 |
| GPS | fixなし、断続fix、境界値、緯度経度範囲外 | `(0,0)` への偽航跡を描かず、不正座標を行番号付きで隔離する。 |
| SD | 書込失敗後の復旧を両機種形式で入力 | 現行 `sd` の意味の違いを吸収せず、品質警告として明示する。 |
| PAIR | DATAのみ、EVENTのみ、別起動同士、同名ファイル複数 | 推測で誤結合しない。縮退表示と不足ファイルを明示する。 |
| BOOT | 2回以上の起動を同一CSVへ追記し、seq/ms/cycleをリセット | ソート前に別セッションへ分割し、波形を交互に混ぜない。 |
| WRAP | `ms=4294967xxx` から小値へ周回 | BOOTのない正当なmillis周回として展開し、負の期間を作らない。 |
| ORDER | seq欠番、重複、逆行、同一ms複数EVENT | 共通連番の正常なファイル間欠番と、破損による逆行を区別する。 |
| CSV | BOM、CRLF/LF/CR、最終改行なし、途中行、余分／不足列、途中ヘッダー | 正常差異は読める。破損行は黙って0/nullにせず、行番号・理由・件数を示す。 |
| QUOTE | カンマ、二重引用符、引用符内改行、未閉鎖引用符 | RFC 4180相当を正しく解析し、不正引用は安全に拒否する。 |
| NUM | `NaN`、`Infinity`、`1e309`、極端値、未知state/phase、bool=2、未知err bit | 非有限値をグラフへ渡さない。未知値は消さず「未知」として報告する。 |
| EVENT | EVENT末尾欠落、VALVE_OFF欠落、DATAとのstate/弁矛盾 | 区間を推定扱いにし、「正確」と断言しない。矛盾数を品質欄へ出す。 |
| DONE | 1サイクル完了後も長時間DATAが続く | `cycle=1,state=3,phase=7` を第2サイクルに数えない。 |
| XSS | `msg`・ファイル名へHTML/SVGイベント、script、bidi制御文字、数式接頭辞 | 常に文字列として表示し、DOM実行・URL遷移・式評価を起こさない。 |
| DOS | 50–100 MB、50万行、10万文字セル、連続再読込・取消 | UIスレッドを長時間占有せず、上限、進捗、取消、明示エラーがある。 |
| A11Y | キーボードのみ、スクリーンリーダー、200%拡大、強制色、reduced motion | 読込・切替・絞込・リセットが操作でき、Canvas情報にテキスト代替がある。 |
| STATIC | `dist` をサブパス配信し、オフラインで読込 | APIなしで動き、意図しない外部通信が0件。オンライン地図は明示同意時のみ。 |

## 将来のログ形式 v4 推奨事項

1. `v` を曖昧なプロトコル番号として流用せず、全行に `schema_version=4`、`device_model`、`firmware_version`、ランダムまたは時刻由来の `boot_id` を持たせる。
2. DATA/EVENTの共通prefixを `schema_version,device_model,firmware_version,boot_id,seq,uptime_ms,timestamp,time_valid` とする。`timestamp` はISO 8601とUTC offsetを含め、無効時は `NA`。
3. 再起動ごとにファイルをローテーションする。難しい場合でも、全行に `boot_id` を記録し、BOOT行だけに依存しない。
4. 単位を列名へ含める。例：`phase_elapsed_s`、`phase_remaining_s`、`max_depth_m`、`pressure_temp_c`、`altitude_m`、`satellite_count`。
5. `sd` を `sd_ready` と `previous_write_ok` に分け、累積 `write_failure_count` を持たせる。未対応の通信列は0/255ではなく `NA`。
6. 温度には `water_temp_c`、`sensor_temp_c` と `water_temp_source=TSYS01|MS5837|NA` を用い、測定源を列名・metadataで明確にする。
7. boolは `0/1`、欠損は大文字 `NA`、数値は有限値のみ、state/phase/error bitの定義をバージョン付き仕様として固定する。
8. 文字列はRFC 4180に従って引用・二重引用符エスケープする。各行の列数を固定し、可能なら `record_crc32` を末尾へ追加して途中書込を検出する。
9. `seq` はDATA/EVENT共通連番であることを仕様化し、同一ms内の順序を保持する。millis周回を避ける64 bit uptime、または `uptime_wrap_count` を用意する。
10. v3.6は読取専用のlegacy adapterとして残し、v4へ推測変換した値には必ず「推定」フラグを付ける。

## 静的ビューアの受入基準

### データ完全性

- DATA/EVENTを相対フォルダ単位で組み合わせ、曖昧な場合は結合しない。
- v3.6では機種を明示選択でき、UmiBotをTritonの温度規則で評価しない。
- 生のファイル順を保持したままBOOT・reset・wrapを検出し、その後で表示用時系列を構築する。
- 必須列、列数、有限値、enum、bool、GPS、機種別センサー範囲を検査し、除外行と理由を表示する。
- EVENT欠落時はDATAへ縮退できるが、推定区間を明示する。両者が矛盾した場合は警告する。
- 完了後DATAを新規サイクルとして数えず、サイクル数・最大深度・期間を既知のダミーデータと一致させる。

### セキュリティとプライバシー

- CSV値、メッセージ、ファイル名をHTMLとして挿入しない。`dangerouslySetInnerHTML`、`eval`、動的script読込を使わない。
- ファイルサイズ、行数、列数、セル長に上限を設け、解析を取消可能にする。非有限値をCanvasへ渡さない。
- 読み込んだCSV内容をLocalStorage、IndexedDB、Service Worker cache、外部分析サービスへ保存・送信しない。
- デフォルトで外部通信を行わない。地図タイル等を追加する場合は、送信先と位置情報漏えいを説明した明示操作を必要とする。

### アクセシビリティと操作性

- ファイル選択、機種・セッション切替、検索、絞込、ズームリセット、クリアをキーボードだけで実行できる。
- フォームに可視ラベル、通知に `role=status` / `role=alert`、タブに適切なARIA状態を付ける。
- グラフごとに要約と表形式の代替を提供し、色だけでphase・弁・警告を区別しない。
- 320 px幅、200%拡大、ライト／ダーク、`prefers-reduced-motion`、強制色でも主要操作と警告が失われない。

### ビルドと配布

- `npm run build` が警告なく成功し、生成した `dist/` だけを任意の静的サーバーから配信できる。
- ルート直下だけでなくサブパスでもasset URLが解決し、バックエンドAPIやPythonを必要としない。
- 正常・異常ダミーセットの自動試験、ビルド済み画面の主要操作試験、アクセシビリティ検査が再現可能である。
- 初回表示、各ダミー読込、破損ファイル拒否、セッション切替で未処理例外やコンソールエラーを出さない。
