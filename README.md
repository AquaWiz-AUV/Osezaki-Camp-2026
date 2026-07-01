# Osezaki Camp 2026

Triton-3 と UmiBot の海上試験向け Arduino firmware、TWELITE 経由で mission plan を送る通信 Web アプリをまとめた公開用パッケージです。

このディレクトリだけを見れば、Arduino への書き込み、通信アプリの起動、SD ログの基本確認まで進められることを目的にしています。

## ディレクトリ構成

```text
Osezaki-Camp-2026/
├── README.md
├── Triton-3/
│   └── Triton-3.ino
├── UmiBot/
│   └── UmiBot.ino
└── communication_app/
    ├── server.py
    ├── package.json
    ├── src/
    └── protocol_v3/pc/
```

- `Triton-3/Triton-3.ino`: Arduino Nano Every に書き込む Triton-3 本体プログラム。
- `UmiBot/UmiBot.ino`: Arduino Nano Every に書き込む UmiBot 本体プログラム。
- `communication_app/`: ブラウザから TWELITE STICK を操作する通信アプリ。
- `communication_app/protocol_v3/pc/`: 通信アプリが使う Triton-3 v3.6 protocol 実装。

## 必要なもの

### ハードウェア

- Arduino Nano Every
- Triton-3 または UmiBot 本体基板
- TWELITE child UART モジュール
- TWELITE STICK
- microSD カード
- TSYS01 水温センサ。Triton-3のみ。UmiBotには搭載しません。
- MS5837 深度/圧力センサ
- RTC RX8025NB
- GPS モジュール
- 任意: I2C LCD

### Arduino ライブラリ

Arduino IDE の Library Manager などから、次のライブラリを使える状態にしてください。

- `TinyGPSPlus`
- `BlueRobotics MS5837 Library`
- `TSYS01`。Triton-3を書き込む場合のみ必要です。
- `TimeLib`
- `RTC_RX8025NB`
- `LiquidCrystal I2C`

Arduino core 標準の `Arduino`, `Wire`, `SPI`, `SD`, `SoftwareSerial` も使用します。

### PC ソフトウェア

通信 Web アプリを使う PC には、次のものを入れてください。macOS と Windows のどちらでも同じアプリを使えます。

- Node.js 20 以降
- Python 3.10 以降
- TWELITE STICK の USB serial driver

## Arduino IDE で書き込む

1. Arduino IDE 2.x を起動します。
2. Triton-3に書き込む場合は `Osezaki-Camp-2026/Triton-3/Triton-3.ino`、UmiBotに書き込む場合は `Osezaki-Camp-2026/UmiBot/UmiBot.ino` を開きます。
3. Board Manager で `Arduino megaAVR Boards` をインストールします。
4. `Tools > Board` で `Arduino Nano Every` を選びます。
5. `Tools > Port` で Arduino Nano Every の USB ポートを選びます。macOS では `/dev/cu.usbmodem...`、Windows では `COM3` などのように見えます。
6. Verify でコンパイルできることを確認し、Upload で書き込みます。

## 通信 Web アプリを起動する

通信アプリは `communication_app/` に分けてあります。TWELITE STICK を PC に挿し、以下を実行してください。

macOS:

```sh
cd Osezaki-Camp-2026/communication_app
npm install
npm run build
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python server.py
```

Windows:

```powershell
cd Osezaki-Camp-2026\communication_app
npm install
npm run build
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python server.py
```

PowerShell の実行ポリシーで仮想環境の有効化が止まる場合は、次のように仮想環境内の Python を直接指定しても同じです。

```powershell
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python server.py
```

起動後、ブラウザで `http://127.0.0.1:8765` を開きます。8765 が使用中の場合は、近い空きポートを自動で探して表示します。

主な操作:

- `Connect`: TWELITE STICK の serial port に接続します。macOS では `/dev/cu.usbserial-...`、Windows では `COM3` などが目安です。
- `Target`: `Triton-3 #1` は `dest=0x78` / `deviceId=0x01`、`UmiBot #1` は `dest=0x78` / `deviceId=0x02` を使います。
- `STATUS`: 現在状態を要求します。
- `SURFACE LINK`: 待機中の疎通確認用です。初期値は ON、5 秒周期です。RUNNING 中は停止します。
- `LOAD + START`: 表示中の plan を送信して開始します。
- `STOP SAFE`: 弁を閉じて安全停止を要求します。

環境変数:

- `TRITON_WEB_GUI_PORT`: Web アプリの開始ポート。初期値は `8765`。
- `TRITON_WEB_GUI_LOG_DIR`: 通信ログ保存先。初期値は `communication_app/logs/`。
- `TRITON_ACK_RETRY_JITTER_FRACTION`: ACK 待ち再送ジッタ。初期値は `0.30`。

## 通信仕様の要点

- PC からは `TWELITE STICK -> TWELITE child UART -> Arduino Serial1` の経路で command を送ります。
- TWELITE UART baudrate は `115200` です。
- Triton-3 の device ID は `0x01`、UmiBot の device ID は `0x02` です。
- 通信アプリの標準 dest はどちらも `0x78` です。同じ `dest` に届いた command は、firmware 内の `DEVICE_ID` が一致した機体だけが処理します。
- `REQUEST_STATUS` は ACK と STATUS を返します。
- 待機中など RUNNING 以外では、firmware 側からも 5 秒ごとに `STATUS` を自動送信します。
- RUNNING 中の周期 telemetry 送信は無効です。水中では無線が届かない前提で、mission は通信に依存しません。

## SD ログ

microSD には主に次の CSV が出力されます。

- `DATA.CSV`: RUNNING 中の周期データ。0.5 秒間隔で記録します。
- `EVENT.CSV`: command、状態遷移、弁制御などのイベント。

`DATA.CSV` の主な列:

- `v`: ログバージョン。この版では `4`。
- `seq`, `ms`, `date`, `time`: 記録番号と時刻。
- `state`, `phase`, `plan`, `cycle`: mission 状態。
- `water_c`: Triton-3ではTSYS01の水温。UmiBotではTR3互換の列位置を維持するため `NA`。
- `press_mbar`, `depth_m`, `max_m`, `press_c`: MS5837 の圧力、深度、最大深度、圧力センサ温度。
- `vinj`, `vexh`: 注入弁/排気弁の状態。`1` が開。
- `sd`, `last_seq`, `last_result`, `pc_age`, `err`: SD と通信/エラー状態。

排気弁または注入弁が開いている制御フェーズ中も、`DATA.CSV` は 0.5 秒間隔で記録します。重い I/O を避けるため、EVENT の flush や LCD 更新は弁制御中に抑制される場合があります。

UmiBotでは standalone 温度センサがないため、Webアプリの `Water Temp` と `TEMP` status flag はMS5837の温度から作ります。CSVでは `water_c` を欠損扱いにし、MS5837温度は既存の `press_c` 列に記録します。

## 現場での確認手順

1. Arduino 書き込み後、USB Serial Monitor で起動ログを確認します。
2. SD が認識されていることを確認します。
3. Web アプリを起動し、TWELITE STICK に接続します。
4. `STATUS` を押して、`SD`, `TEMP`, `DEPTH` の status flag と現在深度/水温を確認します。
5. 陸上では短い `Bench Test` で注入弁の動作のみ確認します。
6. 海上試験では plan の `Max Runtime`, `Max Depth`, 各 phase 秒数、`Repeat` を確認してから `LOAD + START` します。
7. 試験後、microSD の `DATA.CSV` と `EVENT.CSV` を回収します。
