# TR3 / TWELITE 最小通信テスト

センサ、SD、LCD、弁、ミッション制御をすべて外し、次の往復だけを確認します。

```text
PC stick_test.py
  -> TWELITE STICK
  -> 無線
  -> TR3上のTWELITE UART
  -> Arduino Nano Every Serial1
  -> PONG返信（同じ経路を逆向き）
```

## 先に合わせるTWELITE設定

両方とも `App_Uart` を使います。初期値のままでは通信できない組み合わせがあるため、TWELITE STAGEのインタラクティブモードで次を確認してください。

TWELITE用の独自ファームを新規開発する構成ではありません。両機に公式の標準`App_Uart`を入れ、TR3側はArduinoスケッチ、PC側は`stick_test.py`で検証します。

| 設定 | PC側 TWELITE STICK | TR3側 TWELITE UART |
|---|---:|---:|
| App | `App_Uart` | `App_Uart` |
| Application ID | `0x67720103` | `0x67720103` |
| Channel | `18` | `18` |
| Logical Device ID | `121`（親機） | `120`（IDなし子機）または `1` |
| UART mode | `A`（ASCII format） | `A`（ASCII format） |
| UART | `115200, 8N1` | `115200, 8N1` |

重要な点は次の2つです。

- TWELITE STICKのUnifiedファームは出荷時に `App_Wings` が選択される製品があります。`App_Uart` へ切り替えます。
- `App_Uart` のUART mode初期値は `E` です。このテストと既存TR3コードは `A` の `:...<CR><LF>` 形式を前提にします。

TR3側のTWELITE UARTは、起動時に `SET` をGNDへ接続する方法でもASCII format modeを選べます。恒久運用ではTWELITE STAGEで `m=A` を保存しておく方が設定を見失いにくくなります。

### 設定を直す手順

1. TWELITE STAGEで対象を開き、`Interactive Mode`へ入ります。
2. STICKがUnifiedの`App_Wings`等で起動している場合は、App選択画面（`:`）から `App_UART`（`C`）へ切り替えます。選択肢が出た場合、STICKは`Normal`、TR3側のTWELITE UART製品は`for TWELITE UART`を選びます。
3. 親機STICKは `a=67720103`, `i=121`, `c=18`, `m=A`, `r=0`, `C=0` にします。
4. TR3子機は `a=67720103`, `i=120`（または個別ID `1..100`）, `c=18`, `m=A`, `r=0`, `C=0` にします。
5. `S`で保存してリセットし、もう一度`--diagnose-only`を実行します。

メニューに`App_Uart`がない、版が読めない、起動しない場合は、TWELITE STAGEのファームウェア書換機能で、使用中のBLUE/RED/GOLDに合うTWELITE APPS UnifiedまたはApp_Uartを入れ直してから上記設定を行います。異なるシリーズ向けファームは選ばないでください。

### この構成で確認する根本仕様

- `App_Uart` はApplication IDとChannelが両機で一致しないと受信しません。
- Logical ID `121`が親機、`1..100`がID付き子機、`120`がIDなし子機です。旧版には親機`0`もありますが、このテストは`121`へ統一します。
- 設定上の親機Logical IDは`121`ですが、簡易フレームで「親機宛」を示す宛先値は`0x00`です。TR3スケッチの返信先`0x00`はこのためです。
- mode `A` はASCII書式で、1行は `:`、宛先/送信元、`command < 0x80`、payload、LRC8、CRLFの順です。
- 送信直後の `:DBA1...` は、TWELITEがUARTフレームを受理した結果です。相手への無線到達を保証する応答ではありません。本テストはTR3からのPONGまで返って初めて成功にします。
- mode `E` はヘッダ付き透過で `;U;...` などを出すため、このASCIIパーサとは互換性がありません。
- 暗号はこの最小試験では両機とも無効、LayerTree roleは使わず通常値`0`にします。

期待仕様だけをハードなしで表示できます。

```sh
python3 TWELITE-Minimal/stick_test.py --show-spec
```

## TR3側の配線

Arduino Nano EveryのハードウェアUART `Serial1` を使います。

| Nano Every | TWELITE UART |
|---|---|
| `D1/TX` | レベル変換後に `RXD` |
| `D0/RX` | レベル変換後に `TXD` |
| `GND` | `GND` |
| 3.3 V電源 | `VCC` |

TWELITE UARTは3.3 V系です。Nano Everyとの間は双方向の適切なレベル変換を使ってください。TX/RXは交差、GNDは共通です。TR3基板上にレベル変換回路が実装済みなら、その回路を経由します。

## 1. TR3側へ書き込む

Arduino IDEではBoardを `Arduino Nano Every` にして、`TR3-TWELITE-Test/TR3-TWELITE-Test.ino` を開きます。

CLIでコンパイルする場合:

```sh
arduino-cli compile --fqbn arduino:megaavr:nona4809 TWELITE-Minimal/TR3-TWELITE-Test
```

Nano Everyのポートを指定して書き込む場合:

```sh
arduino-cli upload \
  --fqbn arduino:megaavr:nona4809 \
  --port /dev/cu.usbmodemXXXXXXXX \
  TWELITE-Minimal/TR3-TWELITE-Test
```

書き込み後、Nano EveryのUSB Serial Monitorを115200 bpsで開きます。正常なら次を表示します。

```text
TR3_TWELITE_TEST READY
Waiting for PING...
```

## 2. PC側を実行する

Python 3.10以降を使います。初回だけ `pyserial` を入れます。

```sh
python3 -m pip install -r TWELITE-Minimal/requirements.txt
```

コード自身のフレーム/LRC処理を、ハードなしで確認します。

```sh
python3 TWELITE-Minimal/stick_test.py --self-test
```

ポートを確認します。

```sh
python3 TWELITE-Minimal/stick_test.py --list-ports
```

## インタラクティブモードを別プログラムで自動検証する

`interactive_mode_test.py`はPING/PONGとは独立した、保存操作を行わないインタラクティブモード専用テストです。通常モードから開始した場合と、既にインタラクティブモードのトップ画面へ入っていた場合の両方を同期し、次を自動確認します。

1. `CONFIG`メニュー、`App_Uart`、ファームウェア版表示、Serial IDを検出する。
2. Application ID、Channel、親子Logical ID、UART mode `A`を確認する。
3. Enterによるメニュー再表示で、設定値が変化していないことを確認する。
4. メニュー自身が`[ESC]:Exit`を表示する版だけ、ESC終了と再入場を確認する。
5. `+++`による終了と再入場を2周行い、毎回同じ個体・版・全表示設定が読めることを確認する。
6. 事前に成功した終了方法を最後にもう一度送り、通常動作モードと期待される状態（`APP_EXPECTED`）にする。

ホストが送信するのは、インタラクティブモード切替用の`+`、`CONFIG`メニュー確認後の再表示用CR、メニューに対応表示があり終了・再入場まで成功した場合のESCだけです。`S`（保存）、`R`/`!`（リセット）、`:`（App選択）、`*`（追加メニュー）、各設定キー、App_Uart形式フレームは意図して送信しません。

実行直前にTWELITEをハードウェアリセットし、通常動作モードまたは設定トップメニューから開始するのが最も安全です。設定値入力プロンプトやApp選択画面の途中では実行しないでください。このプログラムは標準仕様の115200 bps/8N1固定です。実効baudが異なる設定や`+++`を認識しない別ファームでは`+`が通常データとして解釈される可能性があります。このため「保存コマンドを意図して送らない」検査であり、未知のファームや誤baudで任意の副作用が絶対にないことを保証するものではありません。

まずハードなしの自己テストを実行します。

```sh
python3 TWELITE-Minimal/interactive_mode_test.py --self-test
```

STICKを直接PCへ接続し、一覧からポートを選んで実行します。誤ったシリアル機器へ文字を送らないよう、このプログラムはポートの自動選択をしません。

```sh
python3 TWELITE-Minimal/interactive_mode_test.py --list-ports
python3 TWELITE-Minimal/interactive_mode_test.py \
  --port /dev/cu.usbserial-XXXXXXXX \
  --profile stick
```

TR3側TWELITEを検査するときは、Nano Every経由ではなくTWELITE R/R2/R3などへ直接接続して実行します。

```sh
python3 TWELITE-Minimal/interactive_mode_test.py \
  --port /dev/cu.usbserial-XXXXXXXX \
  --profile client
```

Windows PowerShellでも同じコードを使えます。

```powershell
py -3 -m pip install -r TWELITE-Minimal\requirements.txt
py -3 TWELITE-Minimal\interactive_mode_test.py --self-test
py -3 TWELITE-Minimal\interactive_mode_test.py --list-ports
py -3 TWELITE-Minimal\interactive_mode_test.py --port COM5 --profile stick
```

終了コードは`0=全必須項目PASS`、`1=通信・設定テストFAIL`、`2=ポートや引数などの実行エラー`です。最終表示の`APP_EXPECTED`は、無線フレームを使った通常動作の陽性確認をあえて行わず、直前まで再現できた終了操作から通常モードを推定した状態です。`UNKNOWN`や`reset TWELITE manually`が出た場合は、状態を推測して`+++`を追加送信せず、TWELITEをハードウェアリセットしてから再実行してください。保存済み設定を書き換えるプログラムではないため、設定不一致はTWELITE STAGEで直します。

スティックのファームと設定を読み取りだけで診断します。設定の保存・変更はしません。

```sh
python3 TWELITE-Minimal/stick_test.py \
  --port /dev/cu.usbserial-XXXXXXXX \
  --diagnose-only
```

診断では、ファーム名と版数、Serial ID、Application ID、Channel、親子Logical ID、mode A、実効115200、8N1、role、暗号、option bitsを表示します。

この診断プログラムは正常仕様の115200 bps固定です。BPSピンや`Force Apply Alternate Setting`で別baudを強制した故障状態では、設定画面を読めず「応答なし」までしか判定できません。その場合はTWELITE STAGEで115200へ戻すか、BPS/SET配線を外してリセットしてください。

TR3側TWELITE UART自体も確認する場合は、いったんTWELITE R/R2/R3などへ直接接続して子機プロファイルで実行します。TR3のNano Every経由では設定画面を透過しないため、直接接続が必要です。

```sh
python3 TWELITE-Minimal/stick_test.py \
  --port /dev/cu.usbserial-XXXXXXXX \
  --profile client \
  --diagnose-only
```

PING/PONGを5回実行します。

```sh
python3 TWELITE-Minimal/stick_test.py \
  --port /dev/cu.usbserial-XXXXXXXX
```

設定診断とPING/PONGを続けて実行する場合:

```sh
python3 TWELITE-Minimal/stick_test.py \
  --port /dev/cu.usbserial-XXXXXXXX \
  --diagnose
```

### Windows PowerShell

Windowsでは `python3` の代わりに `py`、ポートには `COM3` などを指定します。

```powershell
py -m pip install -r TWELITE-Minimal\requirements.txt
py TWELITE-Minimal\stick_test.py --list-ports
py TWELITE-Minimal\stick_test.py --port COM5 --diagnose
```

Nano Everyへ書き込む場合:

```powershell
arduino-cli upload --fqbn arduino:megaavr:nona4809 --port COM4 TWELITE-Minimal\TR3-TWELITE-Test
```

STICKとNano Everyが同時に接続されるため、`--list-ports`で確認してSTICK側のCOMポートを明示してください。

## 結果の見方

| 表示 | ここまで正常 | 次に見る場所 |
|---|---|---|
| `OPEN` だけ成功 | USBドライバとシリアルポート | スティックのApp/baud/mode |
| `STICK TX OK`、PONGなし | PCからスティック内の送信受付まで | 両機のApplication ID/channel、TR3側App/配線 |
| TR3 USBに `PING`、`PONG` | 下り無線とArduino UART/処理 | TR3側TWELITEのTX、上り無線 |
| TR3 USBに `TWELITE_TX OK` | TR3側TWELITEがPONGを送信受付 | スティック側Application ID/channel/親機設定 |
| PCに `RX PONG` / `PASS` | 全往復 | TWELITE通信は正常 |
| `TWELITE_BAD ;U;...` | UART自体は受信 | App_Uart modeが `E`。`A`へ変更 |

`PASS` になるまでは既存の40バイト制御プロトコルやセンサ処理を戻さないでください。この最小テストが通れば、故障箇所はTWELITEリンクではなく上位プロトコル側に限定できます。

## 現行コードで起きやすい問題

既存のTR3コマンドは内部40バイトですが、App_UartのASCII行にすると89バイトです。Nano Every標準の`Serial1`受信バッファは64バイトで、115200 bpsでは約5.6 msで埋まります。既存ファームではセンサ読出し、SD、GPS `SoftwareSerial`などが同時に動くため、受信中に処理が重なると行の途中を落とす可能性があります。

この最小PINGは21文字で、センサ等の割込み・待ち時間もありません。したがって次の順で原因を確定できます。

1. 最小PINGも失敗: TWELITEアプリ/設定、配線、電圧、無線の問題。
2. 最小PINGは成功、既存コマンドだけ失敗: 上位プロトコルのCRC/長さ/seq/device/command不整合、64バイト受信バッファ、または既存処理による取りこぼし。
3. `STICK TX OK`のみ: PCとスティックまでは正常。子機設定、無線、TR3側UARTを調べる。

## 公式資料

- [App_Uart ASCII format mode](https://www.twelite.net/en/manuals/twelite-stage-sdk/twelite-apps/app-uart/latest/mode-selection/mode-a.html)
- [App_Uart interactive settings](https://www.twelite.net/en/manuals/twelite-stage-sdk/twelite-apps/app-uart/latest/interactive-mode.html)
- [TWELITE APPS Unified firmware switching](https://www.twelite.net/en/manuals/twelite-stage-sdk/twelite-apps/unified/latest.html)
