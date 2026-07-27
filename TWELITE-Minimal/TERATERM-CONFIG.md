# Tera TermでTWELITE STICK / TWELITE UARTの設定を書き換える

この手順は、`TWELITE-Minimal` の最小PING/PONGテストで使う2台を、WindowsのTera Termから次の設定へ揃えるためのものです。

| 設定 | PC側 TWELITE STICK | TR3側 TWELITE UART |
|---|---:|---:|
| ファーム | `App_Uart` | `App_Uart` |
| Application ID | `0x67720103` | `0x67720103` |
| Channel | `18` | `18` |
| Logical Device ID | `121`（親機） | `120`（IDなし子機）または `1`〜`100` |
| UART mode | `A`（ASCII書式モード） | `A`（ASCII書式モード） |
| UART | `115200, 8N1` | `115200, 8N1` |
| Role | `0` | `0` |
| Encryption | `0`（無効） | `0`（無効） |

> [!IMPORTANT]
> TR3側TWELITEの設定を書き換えるときは、Nano Every経由ではなく、TWELITE R / R2 / R3などでTWELITEへ直接接続します。Tera Term、TWELITE STAGE、Arduino IDEのシリアルモニタ、Pythonスクリプトは同じCOMポートを同時に開けないため、使用するもの以外は閉じてください。

## 1. 配線とピン状態

- TWELITE STICKはPCのUSBポートへ直接接続します。
- TR3側TWELITE UARTは、TWELITE R / R2 / R3などへ接続してPCへつなぎます。
- 設定中は`M3` / `SET`をGNDへ接続しないでください。
- `BPS`も開放しておくと、通常の`115200 bps`で設定できます。
- 設定を保存して`m=A`にした後は、`SET`ピンによる一時的なモード指定に頼らず運用できます。

## 2. Tera Termの通信設定

1. Tera Termを起動します。
2. 「新しい接続」で **シリアル** を選び、対象の`COMx`を開きます。
3. 「設定」→「シリアルポート」で次を指定します。

| 項目 | 値 |
|---|---|
| Speed / Baud rate | `115200` |
| Data | `8 bit` |
| Parity | `none` |
| Stop bits | `1 bit` |
| Flow control | `none` |
| Transmit delay | `0` |

4. 「設定」→「端末」で次を推奨します。

| 項目 | 値 |
|---|---|
| 改行コード Receive | `CR` |
| 改行コード Transmit | `CR` |
| Local echo | `OFF` |

入力文字が二重に見える場合は、Local echoがONになっていないか確認してください。

Tera Term 5をコマンドラインから起動する場合は、COM番号を置き換えて次のようにも指定できます。

```powershell
& "C:\Program Files\teraterm5\ttermpro.exe" `
  /C=5 /BAUD=115200 /CDATABIT=8 `
  /CPARITY=none /CSTOPBIT=1 /CFLOWCTRL=none
```

## 3. インタラクティブモードへ入る

1. Tera TermでCOMポートを開いた状態にします。
2. TWELITEをリセットします。リセットボタンがない場合はUSBを抜き差しします。
3. メインキーボード側の`+`を、**Enterを押さずに**0.2〜1秒間隔で3回入力します。

```text
+    +    +
```

テンキーの`+`では認識されない場合があります。反応しないときは、同じ程度の間隔で`+`を数回追加してください。

成功すると、次のような設定画面が表示されます。

```text
[CONFIG MENU/App_Uart:0/v1-05-1/SID=xxxxxxxx]
a: (0x67720103) ...
i: (       120) ...
c: (18        ) ...
...
[ESC]:Exit [!]:Reset System [*]:Extr Menu [:]:AppSel
```

画面が途中で崩れても、設定メニューの文字が読めれば操作できます。Enterだけを押すと、通常はメニューを再表示できます。

## 4. `App_Uart`へ切り替える

設定画面の先頭が`App_Uart`なら、この節は飛ばしてください。

TWELITE STICKの統合版ファームが`App_Wings`などで起動しており、画面下部に`[:]:AppSel`がある場合は、次の順で操作します。

1. `:`を1回入力します。Enterは不要です。
2. App一覧で`C`を入力して`App_UART`を選びます。
3. バリエーション選択で次を入力します。
   - PC側TWELITE STICK: `1`（通常 / Normal）
   - TR3側TWELITE UART: `2`（TWELITE UART用）
4. 選択後は自動的にリセットされます。
5. 再び`+`をゆっくり3回入力し、`[CONFIG MENU/App_Uart:...]`を表示します。

```text
:  -> AppSel
C  -> App_UART
1  -> TWELITE STICK側
```

または、TR3側TWELITE UARTでは最後を`2`にします。

```text
:  -> AppSel
C  -> App_UART
2  -> TWELITE UART側
```

`[:]:AppSel`が表示されない版や、一覧に`App_UART`がない場合は、Tera Termだけではアプリを書き換えられません。TWELITE STAGEの「アプリ書換」で、使用中のBLUE / RED / GOLDに合うTWELITE APPS統合版または`App_Uart`を書き込んでください。

## 5. PC側TWELITE STICKを親機に設定する

コマンド文字は大文字と小文字を区別します。

- 設定項目の文字は、基本的に**1文字だけ入力**します。Enterは不要です。
- 値の入力プロンプトが出てから値を入力し、最後にEnterを押します。
- 下の行を一括貼り付けせず、各プロンプトを確認しながら1項目ずつ入力してください。

| 操作 | 入力する値 | 意味 |
|---|---:|---|
| `a` | `67720103` + Enter | Application ID |
| `i` | `121` + Enter | 親機Logical ID |
| `c` | `18` + Enter | 周波数チャネル |
| `m` | `A` + Enter | ASCII書式モード |
| `b` | `115200,8N1` + Enter | BPS使用時も115200/8N1 |
| `o` | `00000000` + Enter | オプションをクリア。代替baud強制や応答停止を無効化 |
| `r` | `0` + Enter | 通常の親子配送。LayerTreeを使わない |
| `C` | `0` + Enter | 暗号化を無効化 |

入力例は次のようになります。

```text
a
Input Application ID (HEX:32bit): 67720103<Enter>

i
Input Device ID: 121<Enter>

c
Input Channel(s): 18<Enter>

m
Input UART mode: A<Enter>

b
Input UART Baud: 115200,8N1<Enter>

o
Input Option Bits: 00000000<Enter>

r
Input Role: 0<Enter>

C
Input Encryption: 0<Enter>
```

プロンプトの文言はファームウェア版によって多少異なります。

### 保存前の確認

Enterだけを押してメニューを再表示し、少なくとも次になっていることを確認します。

```text
a: (0x67720103)
i: (       121)
c: (18        )
b: (115200,8N1)
o: (0x00000000)
r: (      0x00)
m: (A         )
C: (         0)
```

問題なければ、**大文字の`S`**を1回入力します。設定が保存され、TWELITEが再起動します。

```text
S
```

小文字の`s`では保存されません。

## 6. TR3側TWELITE UARTを子機に設定する

PC側と同じ手順ですが、Logical Device IDだけを子機用にします。

| 操作 | 入力する値 | 意味 |
|---|---:|---|
| `a` | `67720103` + Enter | Application ID |
| `i` | `120` + Enter | IDなし子機。個別識別する場合は`1`〜`100` |
| `c` | `18` + Enter | 周波数チャネル |
| `m` | `A` + Enter | ASCII書式モード |
| `b` | `115200,8N1` + Enter | BPS使用時も115200/8N1 |
| `o` | `00000000` + Enter | オプションをクリア |
| `r` | `0` + Enter | 通常の親子配送 |
| `C` | `0` + Enter | 暗号化を無効化 |

保存前に次を確認します。

```text
a: (0x67720103)
i: (       120)   <- または 1〜100
c: (18        )
b: (115200,8N1)
o: (0x00000000)
r: (      0x00)
m: (A         )
C: (         0)
```

問題なければ大文字の`S`で保存・再起動します。

## 7. よく使うコマンド一覧

| キー | 動作 | 注意 |
|---|---|---|
| `+++` | インタラクティブモードへ入る／出る | 0.2〜1秒間隔。Enter不要 |
| Enter | メニュー再表示 | 値入力中は、その値を確定する |
| `a` | Application ID | 32bitの16進数。通信する全端末で一致させる |
| `i` | Logical Device ID | 親機`121`、子機`1`〜`100`、IDなし子機`120` |
| `c` | Channel | `11`〜`26`。通信する全端末で一致させる |
| `x` | 送信出力と再送回数 | 今回は既定の`0x03`でよい |
| `b` | UART代替設定 | `BPS`ピンがGND、またはオプションで強制した場合に適用 |
| `o` | Option bits | 今回は`00000000`を推奨 |
| `r` | Role | 今回は`0`。`1`〜`3`は中継子機 |
| `m` | UART通信モード | 今回は`A`。初期値`E`のままでは最小テストと非互換 |
| `C` | 暗号化 | 今回は`0` |
| `S` | 保存して再起動 | **大文字**。設定変更後に必須 |
| `R` | 設定値を初期値へ戻す | その後`S`を押すまで保存されない |
| `!` | システムをリセット | 未保存の変更は失われる |
| `:` | 統合版のApp選択 | 画面下部に`[:]:AppSel`がある場合のみ |
| `ESC` | 設定画面を終了 | 画面下部に`[ESC]:Exit`がある版のみ |

## 8. 設定後の確認

Tera Termを閉じてCOMポートを解放してから、PowerShellで次を実行します。

```powershell
py -3 -m pip install -r TWELITE-Minimal\requirements.txt
py -3 TWELITE-Minimal\stick_test.py --list-ports
py -3 TWELITE-Minimal\stick_test.py --port COM5 --diagnose-only
```

PC側TWELITE STICKでは、主に次が`OK`または`SPEC PASS`になることを確認します。

```text
firmware: App_Uart
Application ID: 0x67720103
channel: 18
Logical ID/topology: 121
UART mode: A
UART framing: 8N1
network role: 0
encryption: 0
TX response option: bit 0x00001000 が0
```

TR3側TWELITE UARTを直接PCへ接続して確認する場合は、子機プロファイルを使います。

```powershell
py -3 TWELITE-Minimal\stick_test.py `
  --port COM6 `
  --profile client `
  --diagnose-only
```

両方の設定が終わったら配線を通常構成へ戻し、PING/PONGを実行します。

```powershell
py -3 TWELITE-Minimal\stick_test.py --port COM5 --diagnose
```

## 9. うまく入れない・文字化けする場合

### `+++`で設定画面が出ない

- TWELITEをリセットした直後に試します。
- `+`はテンキーではなくメインキーボードから入力します。
- `+`の間隔を0.2〜1秒にします。高速な`+++`の貼り付けは避けます。
- Tera Termが`115200 / 8N1 / flow none`か確認します。
- `M3` / `SET`がGNDへ接続されていないか確認します。
- 別のソフトがCOMポートを開いていないか確認します。

### 文字化けする

- Tera Termのbaudを`115200`へ戻します。
- `BPS`ピンを開放してリセットします。
- 以前に`o`の`0x00010000`（代替設定の強制）を有効にした可能性がある場合は、TWELITE STAGEから設定を初期化します。

### `App_Wings`しか表示されない

- 画面下部に`[:]:AppSel`があれば、`:` → `C` → `1`でSTICK側を`App_Uart`へ切り替えます。
- `AppSel`がない場合は、TWELITE STAGEで`App_Uart`または統合版を書き込みます。

### 設定を初期化したい

通常はインタラクティブモードで大文字`R`を入力し、その後に大文字`S`で保存します。通信速度の設定を誤って操作できない場合は、TWELITE STAGEで別アプリへの書換え、初期化、元のアプリへの書戻しが必要になることがあります。

## 公式資料

- [TWELITE APPS: ターミナルソフトからインタラクティブモードへ入る方法](https://twelite.net/manuals/twelite-apps.html#インタラクティブモードに入る方法)
- [App_Uart: インタラクティブモードと設定コマンド](https://twelite.net/manuals/twelite-stage-sdk/twelite-apps/app-uart/latest/interactive-mode.html)
- [App_Uart: 通信モード一覧](https://twelite.net/manuals/twelite-stage-sdk/twelite-apps/app-uart/latest/mode-selection.html)
- [TWELITE APPS統合版: App_Uartへの切替](https://www.twelite.net/manuals/twelite-stage-sdk/twelite-apps/unified/latest.html)
- [Tera Term 5: シリアルポートのコマンドラインオプション](https://teratermproject.github.io/manual/5/ja/commandline/teraterm.html)
- [Tera Term 5: 端末の改行・ローカルエコー設定](https://teratermproject.github.io/manual/5/en/menu/setup-additional-terminal.html)
