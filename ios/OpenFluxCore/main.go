package main

import (
	"flag"
	"fmt"
	"log"
	"os"
        _ "github.com/wlynxg/anet"
	"universal-bypass-tool/tunnel"
	"universal-bypass-tool/utils"
)

var (
	globalDocUrl string
	maxToken     string
	maxUid       string
)

func main() {
	//os.Setenv("GODEBUG", "netdns=go")
        fmt.Print("written by p1neappleXpress\n")

	exitNode := flag.Bool("exit-node", false, "Run as exit node (needs root)")
	client := flag.Bool("client", false, "Run as client")
	debug := flag.Bool("debug", false, "Enable verbose debug logging")
	socksAddr := flag.String("socks5", ":1080", "SOCKS5 address")
	transportType := flag.String("transport", "yandex", "Transport type (yandex, google, custom)")
	dnsServer := flag.String("dns", "1.1.1.1:53", "DNS-сервер, опрашиваемый ЧЕРЕЗ туннель (клиент)")
	localDNS := flag.Bool("local-dns", false, "Резолвить имена локально, как раньше (наследует fake-ip роутера)")
	flag.StringVar(&globalDocUrl, "url", "http://#", "Document URL. If u use Yandex.Docs transport")
	flag.StringVar(&maxToken, "maxToken", "", "MAX call user id. If u use MAX transport")
	flag.StringVar(&maxUid, "maxUid", "", "MAX Web token. If u use MAX transport")
	flag.Parse()

	if !*exitNode && !*client {
		flag.Usage()
		os.Exit(1)
	}

	if *debug {
		utils.EnableDebug()
	}

	log.Printf("=== Universal Bypass Tool ===")
	log.Printf("Mode: %s", map[bool]string{true: "EXIT NODE", false: "CLIENT"}[*exitNode])
	log.Printf("Transport: %s", *transportType)

	cfg := clientConfig{
		Transport: *transportType,
		DocURL:    globalDocUrl,
		MaxToken:  maxToken,
		MaxUID:    maxUid,
		SocksAddr: *socksAddr,
		DNS:       *dnsServer,
	}
	if *localDNS {
		cfg.DNS = "local"
	}

	if *exitNode {
		trans, err := newTransport(cfg, true)
		if err != nil {
			log.Fatalf("Transport: %v", err)
		}
		if err := trans.Start(); err != nil {
			log.Fatalf("Failed to start transport: %v", err)
		}
		tunnel.NewTCPTunnel(trans, true)

		log.Printf("Running as EXIT NODE (needs root for raw socket)")
		log.Printf("! Run: sudo iptables -A OUTPUT -p tcp --tcp-flags RST RST -j DROP")
		select {}
	}

	cl, err := startClient(cfg)
	if err != nil {
		log.Fatalf("Client: %v", err)
	}
	if cfg.DNS == "local" {
		log.Printf("DNS: локальный резолвер (--local-dns)")
	} else {
		log.Printf("DNS: %s через туннель", cfg.DNS)
	}
	if err := cl.Listen(); err != nil {
		log.Fatalf("SOCKS5 %s: %v", *socksAddr, err)
	}
	log.Printf("Running as CLIENT (SOCKS5 on %s)", cl.SocksAddr())
	log.Fatal(cl.Serve())
}
