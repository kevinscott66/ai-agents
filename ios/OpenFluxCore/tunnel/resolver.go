package tunnel

import (
	"context"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"universal-bypass-tool/utils"
)

// Резолв имён через сам туннель.
//
// Клиент не может доверять локальному резолверу: домашние роутеры с Clash/sing-box
// отдают fake-IP из 198.18.0.0/15, а провайдерский DNS в цензурируемой сети
// отравлен ровно на те домены, ради которых туннель и поднят. Любой такой ответ
// клиент честно передал бы ноде, и та ушла бы соединяться в никуда.
//
// Поэтому DNS-запрос уходит по туннелю на публичный резолвер: имя разворачивается
// с точки зрения выходной ноды. Стек туннеля умеет только TCP, поэтому запрос
// идёт DNS-over-TCP (порт 53) - net.Resolver сам выбирает потоковый формат,
// когда Dial возвращает не PacketConn.

const (
	dnsLookupTimeout = 30 * time.Second
	dnsCacheTTL      = 5 * time.Minute
)

type dnsCacheEntry struct {
	ip      net.IP
	expires time.Time
}

type tunnelResolver struct {
	server   string // "1.1.1.1:53"
	resolver *net.Resolver

	mu    sync.Mutex
	cache map[string]dnsCacheEntry
}

func newTunnelResolver(t *TCPTunnel, server string) *tunnelResolver {
	if _, _, err := net.SplitHostPort(server); err != nil {
		server = net.JoinHostPort(server, "53")
	}

	r := &tunnelResolver{
		server: server,
		cache:  make(map[string]dnsCacheEntry),
	}

	r.resolver = &net.Resolver{
		PreferGo: true,
		// Адрес, который подсовывает стандартный резолвер, игнорируем: он взят
		// из локального resolv.conf, а нам нужен именно наш сервер за туннелем.
		Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(r.server)
			if err != nil {
				return nil, err
			}
			ip := net.ParseIP(host).To4()
			if ip == nil {
				return nil, fmt.Errorf("DNS-сервер %q должен быть IPv4-адресом", r.server)
			}
			p, err := net.LookupPort("tcp", port)
			if err != nil {
				return nil, err
			}
			return t.dialThroughTunnel(ctx, [4]byte{ip[0], ip[1], ip[2], ip[3]}, uint16(p))
		},
	}

	return r
}

func (r *tunnelResolver) lookup(ctx context.Context, host string) (net.IP, error) {
	if ip := r.cached(host); ip != nil {
		utils.Debugf("[DNS] %s -> %s (кэш)", host, ip)
		return ip, nil
	}

	// Точка в конце - чтобы резолвер не приписывал search-домены из resolv.conf.
	name := host
	if !strings.HasSuffix(name, ".") {
		name += "."
	}

	ctx, cancel := context.WithTimeout(ctx, dnsLookupTimeout)
	defer cancel()

	start := time.Now()
	addrs, err := r.resolver.LookupIP(ctx, "ip4", name)
	if err != nil {
		return nil, fmt.Errorf("резолв %s через туннель (%s): %w", host, r.server, err)
	}
	if len(addrs) == 0 {
		return nil, fmt.Errorf("резолв %s через туннель: пустой ответ", host)
	}

	ip := addrs[0].To4()
	utils.Debugf("[DNS] %s -> %s (через туннель, %v)", host, ip, time.Since(start).Round(time.Millisecond))

	r.mu.Lock()
	r.cache[host] = dnsCacheEntry{ip: ip, expires: time.Now().Add(dnsCacheTTL)}
	r.mu.Unlock()

	return ip, nil
}

func (r *tunnelResolver) cached(host string) net.IP {
	r.mu.Lock()
	defer r.mu.Unlock()

	e, ok := r.cache[host]
	if !ok {
		return nil
	}
	if time.Now().After(e.expires) {
		delete(r.cache, host)
		return nil
	}
	return e.ip
}

// IsFakeIP сообщает, что адрес пришёл от подменного резолвера и соединяться по
// нему бессмысленно: 198.18.0.0/15 - диапазон бенчмарков (RFC 2544), который
// Clash и sing-box используют под fake-ip, 240.0.0.0/4 - зарезервированный.
func IsFakeIP(ip net.IP) bool {
	v4 := ip.To4()
	if v4 == nil {
		return false
	}
	switch {
	case v4[0] == 198 && (v4[1] == 18 || v4[1] == 19):
		return true
	case v4[0] >= 240:
		return true
	}
	return false
}
