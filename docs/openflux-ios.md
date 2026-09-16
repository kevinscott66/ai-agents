# OpenFlux in the iPhone app

The optional OpenFlux setting routes both native chat requests (`AgentAPI`) and bundled panel requests (`PanelTransport`) through an in-process SOCKS5 listener bound to 127.0.0.1 on an ephemeral port. Local panel assets do not need a tunnel. HTTPS validation and the existing no-redirect policy remain enabled. Proxy failover is explicitly disabled: a failed tunnel never retries a mutation or falls back to direct networking.

Configure under Connection → OpenFlux with the Yandex document used by the existing exit node, then Save and check. Settings stay in this app's device-only Keychain; other apps' Keychains are not imported. Settings are available during pending chat recovery; pairing, server changes and key deletion stay locked. API health is checked through the configured route before reporting success. A successful local SOCKS bind alone is not considered an operational tunnel.

The source snapshot in `ios/OpenFluxCore` derives from the user's local OpenFlux tree at base a8a8937c59fbb275603bd53e150ecaf46e92148e with mobile support. It includes LICENSE/NOTICE, no operational config. `bash ios/build-openflux.sh` reproducibly builds arm64 device and simulator static slices using its pinned Go module graph. Binaries are generated and ignored. `build-unsigned.sh` builds the core first. The app bundles license notices; corresponding source is included in delivery.

Only Yandex is exposed: the supplied MAX implementation has incomplete signaling/connection status and is not claimed operational. Hardening in the embedded snapshot includes bounded typed document parsing, SOCKS stream framing/auth negotiation, WebSocket shutdown/reconnect backoff and tunnel stack disposal. The original OpenFlux working tree is untouched.

Carrier whitelist reachability must be verified on the actual operator. This is an app-scoped tunnel, not a system VPN: external taxi/bank apps and system speech recognition use their own networking. No guarantee of background iOS operation. Document permission/legacy editor and an operational exit node are prerequisites. Credentials are never bundled. Debug-only live probe uses a process environment secret and writes only a sanitized test result.

Apple routing API: https://developer.apple.com/documentation/foundation/urlsessionconfiguration/proxyconfigurations ; explicit no-failover: https://developer.apple.com/documentation/network/proxyconfiguration .
