package tunnel

import (
	"context"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"

	"universal-bypass-tool/transport"
	"universal-bypass-tool/utils"
)

type TCPTunnel struct {
	stopOnce    sync.Once
	done        chan struct{}
	gvisorStack *stack.Stack
	tunnelEP    *TunnelLinkEndpoint
	transport   transport.Transport
	isExitNode  bool
	rawEP       *RawSocketEndpoint
	resolver    *tunnelResolver
	startTime   time.Time
	packetCount atomic.Uint64
}

func NewTCPTunnel(trans transport.Transport, isExitNode bool) *TCPTunnel {
	t := &TCPTunnel{
		done:       make(chan struct{}),
		transport:  trans,
		isExitNode: isExitNode,
		startTime:  time.Now(),
	}

	utils.Debugf("[TUNNEL] Net stack init...")
	t.gvisorStack = stack.New(stack.Options{
		NetworkProtocols:   []stack.NetworkProtocolFactory{ipv4.NewProtocol},
		TransportProtocols: []stack.TransportProtocolFactory{tcp.NewProtocol},
	})

	if err := t.gvisorStack.SetTransportProtocolOption(tcp.ProtocolNumber,
		&tcpip.TCPReceiveBufferSizeRangeOption{Min: 65536, Default: 262144, Max: 1048576}); err != nil {
		utils.Debugf("[TUNNEL] Failed to set recv buffer: %v", err)
	}
	if err := t.gvisorStack.SetTransportProtocolOption(tcp.ProtocolNumber,
		&tcpip.TCPSendBufferSizeRangeOption{Min: 65536, Default: 262144, Max: 1048576}); err != nil {
		utils.Debugf("[TUNNEL] Failed to set send buffer: %v", err)
	}

	tunnelEP := NewTunnelLinkEndpoint()
	tunnelEP.onOutgoingPacket = func(data []byte) {
		trans.Send(data)
	}
	t.tunnelEP = tunnelEP

	tunnelNIC := tcpip.NICID(1)
	if err := t.gvisorStack.CreateNIC(tunnelNIC, tunnelEP); err != nil {
		utils.Debugf("[TUNNEL] CreateNIC tunnel error: %v", err)
	}

	if isExitNode {
		t.setupExitNode(tunnelNIC)
	} else {
		t.setupClient(tunnelNIC)
	}

	trans.Receive(func(data []byte) {
		tunnelEP.InjectInbound(data)
	})

	go t.printStats()
	return t
}

func (t *TCPTunnel) setupExitNode(tunnelNIC tcpip.NICID) {
	localIP := getLocalIP()
	utils.Debugf("[TUNNEL] EXIT NODE - Local IP: %s", localIP)

	rawEP, err := NewRawSocketEndpoint(tcpip.NICID(2))
	if err != nil {
		utils.Debugf("[TUNNEL] Raw socket error: %v", err)
		return
	}

	t.rawEP = rawEP
	rawEP.SetTransportSender(func(data []byte) {
		t.transport.Send(data)
	})

	internetNIC := tcpip.NICID(2)
	if err := t.gvisorStack.CreateNIC(internetNIC, rawEP); err != nil {
		utils.Debugf("[TUNNEL] CreateNIC internet error: %v", err)
		return
	}

	var ipBytes [4]byte
	fmt.Sscanf(localIP, "%d.%d.%d.%d", &ipBytes[0], &ipBytes[1], &ipBytes[2], &ipBytes[3])
	internetAddr := tcpip.AddrFrom4(ipBytes)
	t.gvisorStack.AddProtocolAddress(internetNIC, tcpip.ProtocolAddress{
		Protocol: ipv4.ProtocolNumber,
		AddressWithPrefix: tcpip.AddressWithPrefix{
			Address:   internetAddr,
			PrefixLen: 24,
		},
	}, stack.AddressProperties{})

	t.gvisorStack.SetForwardingDefaultAndAllNICs(ipv4.ProtocolNumber, true)
	t.gvisorStack.AddRoute(tcpip.Route{
		Destination: header.IPv4EmptySubnet,
		NIC:         internetNIC,
	})

	tunnelSubnet := tcpip.AddressWithPrefix{
		Address:   tcpip.AddrFrom4([4]byte{10, 10, 10, 0}),
		PrefixLen: 24,
	}.Subnet()
	t.gvisorStack.AddRoute(tcpip.Route{
		Destination: tunnelSubnet,
		NIC:         tunnelNIC,
	})
}

func (t *TCPTunnel) setupClient(tunnelNIC tcpip.NICID) {
	clientAddr := tcpip.AddrFrom4([4]byte{10, 10, 10, 2})
	t.gvisorStack.AddProtocolAddress(tunnelNIC, tcpip.ProtocolAddress{
		Protocol: ipv4.ProtocolNumber,
		AddressWithPrefix: tcpip.AddressWithPrefix{
			Address:   clientAddr,
			PrefixLen: 24,
		},
	}, stack.AddressProperties{})

	t.gvisorStack.AddRoute(tcpip.Route{
		Destination: header.IPv4EmptySubnet,
		NIC:         tunnelNIC,
	})
}

// SetTunnelDNS переводит резолв имён на DNS-сервер, доступный через туннель.
// Без него клиент резолвит локально и наследует fake-ip домашнего роутера и
// отравленный DNS провайдера. Подробности - в resolver.go.
func (t *TCPTunnel) SetTunnelDNS(server string) {
	t.resolver = newTunnelResolver(t, server)
	utils.Debugf("[DNS] резолв через туннель, сервер %s", t.resolver.server)
}

func (t *TCPTunnel) nicID() tcpip.NICID {
	if t.isExitNode {
		return tcpip.NICID(2)
	}
	return tcpip.NICID(1)
}

func (t *TCPTunnel) dialThroughTunnel(ctx context.Context, ip [4]byte, port uint16) (net.Conn, error) {
	conn, err := gonet.DialContextTCP(ctx, t.gvisorStack, tcpip.FullAddress{
		NIC:  t.nicID(),
		Addr: tcpip.AddrFrom4(ip),
		Port: port,
	}, ipv4.ProtocolNumber)
	if err != nil {
		return nil, err
	}
	return conn, nil
}

func (t *TCPTunnel) DialTCP(address string) (net.Conn, error) {
	host, portStr, err := net.SplitHostPort(address)
	if err != nil {
		return nil, fmt.Errorf("разбор адреса %q: %w", address, err)
	}
	port, err := net.LookupPort("tcp", portStr)
	if err != nil {
		return nil, fmt.Errorf("порт в %q: %w", address, err)
	}

	ip := net.ParseIP(host)
	if ip == nil {
		if t.resolver != nil {
			ip, err = t.resolver.lookup(context.Background(), host)
		} else {
			var tcpAddr *net.TCPAddr
			tcpAddr, err = net.ResolveTCPAddr("tcp4", address)
			if tcpAddr != nil {
				ip = tcpAddr.IP
			}
		}
		if err != nil {
			return nil, fmt.Errorf("resolve: %w", err)
		}
	}

	v4 := ip.To4()
	if v4 == nil {
		return nil, fmt.Errorf("IPv6 not supported")
	}
	// Соединяться по подменному адресу бессмысленно: нода отправит SYN в никуда.
	// Лучше внятная ошибка, чем таймаут на 45 секунд.
	if IsFakeIP(v4) {
		return nil, fmt.Errorf("%s резолвится в подменный адрес %s: локальный DNS отдаёт fake-ip, нужен резолв через туннель", host, v4)
	}

	return t.dialThroughTunnel(context.Background(), [4]byte{v4[0], v4[1], v4[2], v4[3]}, uint16(port))
}

func (t *TCPTunnel) ListenTCP(port uint16) (net.Listener, error) {
	return gonet.ListenTCP(t.gvisorStack, tcpip.FullAddress{
		NIC:  1,
		Port: port,
	}, ipv4.ProtocolNumber)
}

func (t *TCPTunnel) printStats() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-t.done:
			return
		case <-ticker.C:
		}
		stats := t.gvisorStack.Stats()
		utils.Debugf("[STATS] uptime=%v packets=%d connected=%d established=%d retrans=%d",
			time.Since(t.startTime).Round(time.Second),
			t.packetCount.Load(),
			stats.TCP.CurrentConnected.Value(),
			stats.TCP.CurrentEstablished.Value(),
			stats.TCP.Retransmits.Value(),
		)
	}
}

func getLocalIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return "192.168.1.100"
	}
	defer conn.Close()
	localAddr := conn.LocalAddr().(*net.UDPAddr)
	return localAddr.IP.String()
}

// Close releases the client stack and the statistics goroutine exactly once.
func (t *TCPTunnel) Close() {
	t.stopOnce.Do(func() {
		close(t.done)
		t.gvisorStack.Close()
	})
}
