# TON Site — `cryptodelabs.ton` → сайт DeLabs

Развёрнуто 2026-08-06 на VPS `203.0.113.10` (prod-host).

## Что это

У TON DNS нет A-записи. Домен `.ton` указывает на **ADNL-адрес**, а не на IP.
Чтобы `.ton` отдавал обычный сайт, на сервере должен крутиться прокси, который
принимает соединения по ADNL (UDP) и перекладывает их в локальный HTTP.

Такой сайт **не открывается в обычном Chrome**. Доступ — только через клиент с
поддержкой TON Proxy (расширение, MyTonWallet, Tonutils-Proxy). Конкретный
список проверенных клиентов — в разделе «Совместимость клиентов» ниже; он важнее,
чем кажется: у неподдерживающего клиента симптом — белый экран без ошибки.

Это ограничение протокола, а не конфигурации. `delabs.space` остаётся основным
адресом для обычного веба — `.ton` идёт вторым каналом, а не заменой.

## Схема

```
Tonkeeper / TON Proxy
        │  ADNL over UDP :13104
        ▼
tonutils-reverse-proxy  (systemd: ton-proxy.service, user tonproxy)
        │  HTTP
        ▼
127.0.0.1:8790   ← Bun-сервер сайта (site/server), тот же, что за nginx
                   для delabs.space
```

nginx в этой цепочке не участвует: прокси ходит прямо в Bun. Так не нужно
подбирать `server_name` под `.ton` и не нужен сертификат — ADNL шифрует
транспорт сам.

## Установленное

| Что | Значение |
|---|---|
| Бинарь | `tonutils-reverse-proxy` v0.5.0 linux-amd64 |
| Источник | `github.com/tonutils/reverse-proxy` releases |
| sha256 | `ee245c2caf73ba8b479216000d4f042a531652b36c9e4a3cb7e358c67b7556b1` |
| Каталог | `/opt/ton-proxy` (owner `tonproxy:tonproxy`) |
| Юнит | `/etc/systemd/system/ton-proxy.service` (копия — рядом в этом каталоге) |
| Порт | UDP `13104`, `listen_ip 0.0.0.0`, `external_ip 203.0.113.10` |
| proxy_pass | `http://127.0.0.1:8790/` |
| ADNL | `vaivnibaeepoh72qnsypxbghmn3kzbq7zub7efgsybsddjepxtmxm6x` |
| ADNL hex | `408ab5010108f71ffa836587dc263b1bb56430fe681f90a69603218d247de6cb` |

Ключ ротирован 2026-08-06 (прежний ADNL `waz6osna…` скомпрометирован — попал в
транскрипт вместе с `config.json`; он больше нигде не действует). Актуальный
ADNL всегда можно перечитать из журнала, не трогая приватный ключ:

```bash
ssh root@203.0.113.10 'journalctl -u ton-proxy --no-pager | grep -i "Server.s ADNL address" | tail -1'
```

`/opt/ton-proxy/config.json` содержит **приватный ключ ADNL** — режим `600`,
владелец `tonproxy`. В git его нет и быть не должно. Не выводите файл целиком:
кроме ADNL там `TunnelServerKey`, `ADNLServerKey`, `PaymentsNodeKey` и
`WalletPrivateKey`. Потеря ключа не катастрофична: генерируется новый ADNL, и
домен перепривязывается (см. ниже) — но это ончейн-транза и ручная подпись
владельца, так что дешевле файл не светить.

## Привязка домена (делает владелец кошелька)

Запись `site` в TON DNS ставится ончейн-транзакцией с кошелька-владельца NFT.
Из репозитория/CI это невозможно — только вручную из кошелька.

```bash
ssh root@203.0.113.10 'systemctl stop ton-proxy && cd /opt/ton-proxy && ./tonutils-reverse-proxy --domain cryptodelabs.ton'
```

Бинарь покажет QR — отсканировать Tonkeeper'ом с кошелька-владельца, подтвердить
(~0.02 TON комиссии). Через ~10 секунд прокси сам увидит запись. После этого:

```bash
ssh root@203.0.113.10 'systemctl start ton-proxy'
```

Флаг `--domain` нужен **только на привязку**. Дальше сервис стартует без него —
запись живёт в блокчейне.

Флаг `-tx-url` вместо QR печатает `ton://`-ссылку, если сканировать неудобно.

### Ротация ключа

Если приватный ключ утёк — новый ADNL и повторная привязка. Делалось 2026-08-06,
процедура рабочая:

```bash
ssh root@203.0.113.10 'systemctl stop ton-proxy && cd /opt/ton-proxy && \
  cp config.json config.json.old && \
  python3 -c "import json;c=json.load(open(\"config.json\"));print(json.dumps({k:v for k,v in c.items() if k not in (\"private_key\",\"TunnelServerKey\",\"ADNLServerKey\",\"PaymentsNodeKey\",\"WalletPrivateKey\")},indent=2))" && \
  rm config.json && ./tonutils-reverse-proxy -domain cryptodelabs.ton -tx-url'
```

Бинарь без `config.json` генерирует новый ключ, печатает новый ADNL и ссылку на
транзакцию. Дальше: вернуть в свежий `config.json` прежние `proxy_pass`,
`external_ip`, `listen_ip`, `port` (их печатает команда выше), выставить
`chmod 600` + `chown tonproxy`, подписать транзакцию из кошелька-владельца,
проверить резолв (раздел «Проверка»), и только потом `shred -u
config.json.old`. Пока транзакция не подтверждена, старый конфиг — единственный
способ откатиться.

Проверять, что подпись прошла, надо **ончейн**, а не по ощущениям: у транзакции
должно быть `op 0x4eb1f0f9`, `exit=0`, и новый ADNL в теле сообщения.

### Привязка без остановки сервиса — `dns-tool/`

Альтернатива QR-флоу бинаря: `dns-tool/build-site-record.mjs` строит payload
`change_dns_record` локально из hex ADNL (таблица выше / журнал юнита) — прокси
останавливать не нужно, транзакция уходит из кошелька напрямую:

```bash
cd deploy/ton/dns-tool && npm install
node build-site-record.mjs --adnl <ADNL hex> --nft <адрес NFT домена>
```

Печатает base64-payload и следом готовую `ton://`-ссылку (открыть
кошельком-владельцем, 0.02 TON). Формат сверен с tonutils-go `resolve.go` и
TEP-81, есть `--self-test`. Версии зависимостей запинены точно — инструмент
строит ончейн-payload, плавающие версии тут ни к чему.

### Rate-limit и .ton-трафик

Весь `.ton`-трафик приходит в Bun с петли БЕЗ клиентских заголовков — лимитер
сайта складывает его в одно общее ведро `ip:127.0.0.1` (60 req/мин по
умолчанию). Чтобы `.ton`-аудитория не упиралась в потолок, на VPS в окружение
юнита `web3-puls` добавляется `SITE_LOOPBACK_RL_CAPACITY=600` (drop-in по
аналогии с `ingest.conf`). Без переменной поведение прежнее. base64-вариант пригоден для агентских кошелёк-тулов с
`payload.type=base64` — например, официальный My Wallet плагин для Claude Code
(`/plugin marketplace add mytonwallet-org/mywallet-agents-plugins`,
`/plugin install mywallet-claude-code`, тул `mywallet_submit_transfer`) — но
это сработает, только если кошелёк агента сам владеет NFT домена; плагин
ставить в локальный Claude Code, не в облачную сессию (эфемерные ключи).
Пока NFT в кошельке владельца — `ton://`-ссылка остаётся самым коротким путём.
Проверка результата — та же ончейн-проверка, что выше.

## Проверка

Статус сервиса и UDP-сокета:

```bash
ssh root@203.0.113.10 'systemctl is-active ton-proxy; ss -lunp | grep 13104'
```

Бэкенд под `.ton`-хостом:

```bash
ssh root@203.0.113.10 "curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: cryptodelabs.ton' http://127.0.0.1:8790/"
```

**Резолв записи — только через сам прокси, не через tonapi.** Он читает запись с
лайтсерверов и сверяет с текущим ADNL:

```bash
ssh root@203.0.113.10 'systemctl stop ton-proxy; cd /opt/ton-proxy && timeout 40 ./tonutils-reverse-proxy -debug -domain cryptodelabs.ton -tx-url; systemctl start ton-proxy'
```

Ждём `Domain is already configured to use with current ADNL address. Everything
is OK!` и строку `DHT ADNL address record ... refreshed successfully on N nodes`.
Порт один, поэтому юнит на время проверки надо остановить.

`https://tonapi.io/v2/dns/<name>/resolve` для этого **не годится**: поле `sites`
у него пустое и у заведомо живых сайтов (проверено на `foundation.ton`). Пустой
`sites: []` ничего не означает — не принимайте его за поломку.

### Сквозная проверка через ADNL

Единственный тест, который проверяет весь контур (DNS → ADNL → DHT → RLDP →
бэкенд) и не зависит от кошелька. Клиент — CLI из
[xssnick/Tonutils-Proxy](https://github.com/xssnick/Tonutils-Proxy):

```bash
ssh root@203.0.113.10 'cd /tmp && curl -sL -o tp https://github.com/xssnick/Tonutils-Proxy/releases/download/v1.8.3/tonutils-proxy-cli-linux-amd64 && chmod +x tp && nohup timeout 90 ./tp -addr 127.0.0.1:18080 >/tmp/tp.log 2>&1 & sleep 25; curl -s -m 45 -x http://127.0.0.1:18080 -w "\ncode=%{http_code} size=%{size_download}\n" http://cryptodelabs.ton/ | tail -3; pkill -x tp; rm -f /tmp/tp /tmp/tp.log'
```

Проверено 2026-08-06: `200`, 2806 байт, 264 мс; ассеты (`.js`, `.css`,
`favicon.svg`) тоже отдаются с верным MIME.

Уровень логирования по умолчанию у прокси почти немой — запросы он пишет
**только под `-debug`** (`Received HTTP request host=... uri=...`). Если надо
увидеть, доходит ли клиент, временно добавьте флаг в `ExecStart` и не забудьте
убрать: под `-debug` в журнал сыпется весь RLDP-трейс.

## Совместимость клиентов

`.ton` живёт поверх ADNL, а не HTTP, поэтому нужен клиент с поддержкой TON
Proxy. Обычный браузер, DNS и CDN тут ни при чём.

| Клиент | Открывает `.ton` |
|---|---|
| Tonutils-Proxy (CLI/GUI), TON Proxy extension | да — проверено |
| MyTonWallet | да |
| Tonkeeper (встроенный браузер) | **нет** — проверено 2026-08-06 |
| Встроенный браузер Telegram | **нет** — схему не резолвит вовсе |
| Chrome/Safari без расширения | нет |

Типичный симптом неподдерживающего клиента — **белый экран без ошибки**:
приложение не резолвит имя, показывать нечего. Отличить от реальной поломки
просто: если в логе прокси под `-debug` нет ни одного `Received HTTP request`, а
в `tcpdump -nn -i any udp port 13104` не видно IP клиента — до сервера запрос не
дошёл, и чинить надо не сервер.

## Известные мелочи

- `SITE_ORIGIN` в `site/server/index.ts` захардкожен на `https://delabs.space` —
  RSS с `.ton` будет ссылаться на канонический домен. Это осознанно: `.ton`
  недоступен из обычного браузера, и уводить RSS-читателя туда нельзя.
- Сайт привязан и работает с 2026-08-06 (транза `op 0x4eb1f0f9`, `exit=0`).
  Ключ ротирован в тот же день, 15:42:10 UTC — сквозная проверка через ADNL
  после ротации прошла (`200`, 2806 байт).
- Домен оплачен примерно до августа 2027 (`expiring_at` в
  `https://tonapi.io/v2/dns/cryptodelabs.ton`). TON DNS требует продления —
  просроченный домен уходит на аукцион.
- Прокси требует белый IP и открытый UDP-порт. На prod-host `ufw` выключен,
  политика `INPUT ACCEPT` — работает. Если фаервол будут включать, `13104/udp`
  надо открыть явно.
