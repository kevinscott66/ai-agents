package main

import (
	"fmt"
	"strconv"
	"sync"

	"universal-bypass-tool/socks5"
	"universal-bypass-tool/transport"
	"universal-bypass-tool/transport/oneme"
	"universal-bypass-tool/transport/yandex"
	"universal-bypass-tool/tunnel"
)

// Клиентская часть, вынесенная из main: CLI и мобильная обвязка (export_mobile.go)
// поднимают её одинаково. На iOS/Android main() не вызывается вообще, поэтому
// вся логика запуска должна жить вне его.

type clientConfig struct {
	Transport string // yandex | oneme
	DocURL    string // для yandex
	MaxToken  string // для oneme
	MaxUID    string // для oneme
	SocksAddr string // ":1080", можно ":0" - порт выберет система
	DNS       string // "1.1.1.1:53" или "local" для локального резолвера
}

type client struct {
	trans  transport.Transport
	tunnel *tunnel.TCPTunnel
	socks  *socks5.SOCKS5Server

	stopOnce sync.Once
}

func newTransport(cfg clientConfig, exitNode bool) (transport.Transport, error) {
	config := transport.DefaultConfig()

	switch cfg.Transport {
	case "yandex":
		if cfg.DocURL == "" {
			return nil, fmt.Errorf("для транспорта yandex нужен URL документа")
		}
		return transport.NewCompressedTransport(yandex.NewYandexDocsTransport(cfg.DocURL, config)), nil
	case "oneme":
		uid, err := strconv.ParseInt(cfg.MaxUID, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("maxUid должен быть числом: %w", err)
		}
		return transport.NewCompressedTransport(oneme.NewOneMeTransport(exitNode, cfg.MaxToken, uid, config)), nil
	default:
		return nil, fmt.Errorf("неизвестный транспорт %q", cfg.Transport)
	}
}

// startClient поднимает транспорт и туннель, но НЕ начинает принимать
// SOCKS5-соединения: для этого вызывается Serve.
func startClient(cfg clientConfig) (*client, error) {
	trans, err := newTransport(cfg, false)
	if err != nil {
		return nil, err
	}
	if err := trans.Start(); err != nil {
		return nil, fmt.Errorf("транспорт не поднялся: %w", err)
	}

	tun := tunnel.NewTCPTunnel(trans, false)
	if cfg.DNS != "local" && cfg.DNS != "" {
		tun.SetTunnelDNS(cfg.DNS)
	}

	return &client{
		trans:  trans,
		tunnel: tun,
		socks:  socks5.NewSOCKS5Server(cfg.SocksAddr, tun),
	}, nil
}

// Listen занимает порт синхронно, Serve блокирует до вызова Stop.
func (c *client) Listen() error { return c.socks.Listen() }
func (c *client) Serve() error  { return c.socks.Serve() }

// SocksAddr - фактический адрес SOCKS5 (важно при порте 0).
func (c *client) SocksAddr() string {
	if a := c.socks.Addr(); a != nil {
		return a.String()
	}
	return ""
}

func (c *client) Stop() {
	c.stopOnce.Do(func() {
		c.socks.Stop()
		c.trans.Stop()
		c.tunnel.Close()
	})
}
