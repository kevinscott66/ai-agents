# TON Site: `cryptodelabs.ton` → DeLabs

Recorded deployment: 2026-08-06. Commands below use the documentation host `203.0.113.10`; substitute an authorized deployment target. These dated observations are not a current infrastructure check.

## Overview

TON DNS maps a `.ton` domain to an **ADNL address**, not an IP A record. A reverse proxy accepts ADNL over UDP and forwards requests to local HTTP.

An ordinary Chrome browser cannot open it without TON Proxy support. Supported clients are listed below; an unsupported client often shows a blank page. This is a protocol limitation, not a server configuration issue. `delabs.space` remains the canonical web address; `.ton` is an additional channel.

## Architecture

```text
TON Proxy client
        | ADNL over UDP :13104
        v
tonutils-reverse-proxy (ton-proxy.service, user tonproxy)
        | HTTP
        v
127.0.0.1:8790 (site/server Bun backend, also used by delabs.space through nginx)
```

nginx is not involved in the TON route. The proxy connects directly to Bun, avoiding `.ton` server-name and TLS-certificate configuration; ADNL encrypts transport.

## Recorded installation

| Item | Value |
| --- | --- |
| Binary | `tonutils-reverse-proxy` v0.5.0 linux-amd64 |
| Source | `github.com/tonutils/reverse-proxy` releases |
| SHA-256 | `ee245c2caf73ba8b479216000d4f042a531652b36c9e4a3cb7e358c67b7556b1` |
| Directory | `/opt/ton-proxy`, owned by `tonproxy:tonproxy` |
| Unit | `/etc/systemd/system/ton-proxy.service`; template in this directory |
| Port | UDP `13104`, `listen_ip 0.0.0.0`; configure the actual `external_ip` privately |
| Upstream | `http://127.0.0.1:8790/` |
| Public ADNL | `vaivnibaeepoh72qnsypxbghmn3kzbq7zub7efgsybsddjepxtmxm6x` |
| Public ADNL hex | `408ab5010108f71ffa836587dc263b1bb56430fe681f90a69603218d247de6cb` |

The key was rotated on 2026-08-06 after the previous configuration was exposed. Read the current public ADNL from logs without displaying the private key:

```bash
ssh root@203.0.113.10 'journalctl -u ton-proxy --no-pager | grep -i "Server.s ADNL address" | tail -1'
```

`/opt/ton-proxy/config.json` contains the **ADNL private key**, is owned by `tonproxy`, and must be mode `600`. Never commit or print the whole file: it can also contain `TunnelServerKey`, `ADNLServerKey`, `PaymentsNodeKey` and `WalletPrivateKey`. Losing the key requires a new ADNL and owner-signed on-chain domain rebinding.

## Domain binding: wallet owner only

The TON DNS `site` record requires an on-chain transaction signed by the wallet holding the domain NFT. Repository/CI access does not grant that authority.

```bash
ssh root@203.0.113.10 'systemctl stop ton-proxy && cd /opt/ton-proxy && ./tonutils-reverse-proxy --domain cryptodelabs.ton'
```

Scan the QR code with the owning wallet and confirm. The recorded fee was approximately 0.02 TON and detection took about ten seconds; these are historical observations, not guaranteed current values. Then start the service:

```bash
ssh root@203.0.113.10 'systemctl start ton-proxy'
```

`--domain` is needed only for binding; subsequent service starts omit it because the record is on-chain. `-tx-url` prints a `ton://` link instead of a QR code.

### Key rotation

After exposure, generate a new ADNL and rebind. The recorded 2026-08-06 procedure:

```bash
ssh root@203.0.113.10 'systemctl stop ton-proxy && cd /opt/ton-proxy && \
  cp config.json config.json.old && \
  python3 -c "import json;c=json.load(open(\"config.json\"));print(json.dumps({k:v for k,v in c.items() if k not in (\"private_key\",\"TunnelServerKey\",\"ADNLServerKey\",\"PaymentsNodeKey\",\"WalletPrivateKey\")},indent=2))" && \
  rm config.json && ./tonutils-reverse-proxy -domain cryptodelabs.ton -tx-url'
```

Without `config.json`, the binary generates a new key and prints the public ADNL and transaction link. Restore `proxy_pass`, `external_ip`, `listen_ip` and `port` from the sanitized output; set mode 600 and ownership `tonproxy`. The wallet owner signs, verifies resolution, and only then removes the old configuration with `shred -u config.json.old`. Until confirmation, the old configuration is the rollback path.

Verify on-chain: operation `0x4eb1f0f9`, exit code 0, and the new ADNL in the message body.

### Binding without stopping the service

`dns-tool/build-site-record.mjs` builds a local `change_dns_record` payload from the public hexadecimal ADNL. The proxy can stay running while the owner sends the wallet transaction:

```bash
cd deploy/ton/dns-tool && npm install
node build-site-record.mjs --adnl <ADNL hex> --nft <domain NFT address>
```

The tool prints a base64 payload and a `ton://` link. The recorded payload format was checked against tonutils-go `resolve.go` and TEP-81; `--self-test` is available. Dependencies are exactly pinned because this constructs an on-chain payload.

### Rate limiting and wallet tools

TON requests reach Bun through loopback without client headers, sharing the `ip:127.0.0.1` bucket (default 60 requests/minute). The documented service drop-in sets `SITE_LOOPBACK_RL_CAPACITY=600` for the historical `web3-puls` unit; verify the actual current unit before applying. Without the variable, behavior is unchanged.

The base64 payload can be used with wallet tools accepting `payload.type=base64`, such as the official My Wallet plugin (`/plugin marketplace add mytonwallet-org/mywallet-agents-plugins`, `/plugin install mywallet-claude-code`, `mywallet_submit_transfer`). The connected wallet must itself own the NFT. Install in the local client, not an ephemeral cloud session. Otherwise use the owning wallet's `ton://` link. Verify the resulting transaction on-chain in either case.

## Verification

Service and UDP socket:

```bash
ssh root@203.0.113.10 'systemctl is-active ton-proxy; ss -lunp | grep 13104'
```

Backend with the TON Host header:

```bash
ssh root@203.0.113.10 "curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: cryptodelabs.ton' http://127.0.0.1:8790/"
```

**Resolve through the proxy itself**, which reads lite-server records and compares the current ADNL:

```bash
ssh root@203.0.113.10 'systemctl stop ton-proxy; cd /opt/ton-proxy && timeout 40 ./tonutils-reverse-proxy -debug -domain cryptodelabs.ton -tx-url; systemctl start ton-proxy'
```

Expect `Domain is already configured to use with current ADNL address. Everything is OK!` and successful DHT record refresh. Stop the service temporarily because the diagnostic instance uses the same port.

The recorded `https://tonapi.io/v2/dns/<name>/resolve` response had empty `sites` even for known working sites such as `foundation.ton`; `sites: []` alone did not establish failure.

### End-to-end ADNL check

The [Tonutils-Proxy CLI](https://github.com/xssnick/Tonutils-Proxy) exercises DNS → ADNL → DHT → RLDP → backend without a wallet:

```bash
ssh root@203.0.113.10 'cd /tmp && curl -sL -o tp https://github.com/xssnick/Tonutils-Proxy/releases/download/v1.8.3/tonutils-proxy-cli-linux-amd64 && chmod +x tp && nohup timeout 90 ./tp -addr 127.0.0.1:18080 >/tmp/tp.log 2>&1 & sleep 25; curl -s -m 45 -x http://127.0.0.1:18080 -w "\ncode=%{http_code} size=%{size_download}\n" http://cryptodelabs.ton/ | tail -3; pkill -x tp; rm -f /tmp/tp /tmp/tp.log'
```

Recorded on 2026-08-06: HTTP 200, 2806 bytes, 264 ms; JS, CSS and favicon assets had correct MIME types. This command uses a pinned historical client binary and is a documented diagnostic, not an instruction to run it automatically.

Requests appear in logs only with `-debug` (`Received HTTP request host=... uri=...`). Enable it temporarily if needed and remove it afterward; it emits the full RLDP trace.

## Recorded client compatibility

| Client | `.ton` support |
| --- | --- |
| Tonutils-Proxy CLI/GUI, TON Proxy extension | Verified |
| MyTonWallet | Supported in the recorded setup |
| Tonkeeper embedded browser | Did not work in the 2026-08-06 check |
| Telegram embedded browser | Did not resolve the scheme |
| Chrome/Safari without extension | Unsupported |

A blank screen can mean the client never resolved the name. If debug logs show no request and `tcpdump -nn -i any udp port 13104` shows no client traffic, the request did not reach the server.

## Notes

- `SITE_ORIGIN` in `site/server/index.ts` uses `https://delabs.space`; RSS intentionally points to the canonical browser-accessible domain.
- Domain binding and post-rotation end-to-end checks succeeded on 2026-08-06; the recorded rotation time was 15:42:10 UTC.
- The recorded domain expiry was around August 2027; inspect current `expiring_at` at `https://tonapi.io/v2/dns/cryptodelabs.ton`. Expired TON DNS domains return to auction.
- The proxy requires a public IP and accessible UDP port. The historical deployment had no blocking firewall; when enabling one, explicitly allow `13104/udp`. Check current host policy rather than assuming that historical state still applies.
