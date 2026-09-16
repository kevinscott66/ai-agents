package socks5

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"time"

	"universal-bypass-tool/utils"
)

type Dialer interface {
	DialTCP(address string) (net.Conn, error)
}

type SOCKS5Server struct {
	listenAddr string
	dialer     Dialer

	mu       sync.Mutex
	listener net.Listener
	closed   bool
}

func NewSOCKS5Server(addr string, dialer Dialer) *SOCKS5Server {
	return &SOCKS5Server{listenAddr: addr, dialer: dialer}
}

// Addr возвращает реальный адрес прослушивания. Нужен, когда порт задан нулём
// и его выбирает система - на iOS так удобнее, чем занимать фиксированный.
func (s *SOCKS5Server) Addr() net.Addr {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listener == nil {
		return nil
	}
	return s.listener.Addr()
}

// Stop закрывает листенер и разблокирует Start. Уже установленные соединения
// не рвёт - они доживают сами.
func (s *SOCKS5Server) Stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	l := s.listener
	s.listener = nil
	if l == nil {
		return nil
	}
	return l.Close()
}

// Start = Listen + Serve. Мобильной обвязке нужны они по отдельности: сначала
// синхронно занять порт (чтобы узнать адрес), потом крутить приём в горутине.
func (s *SOCKS5Server) Start() error {
	if err := s.Listen(); err != nil {
		return err
	}
	return s.Serve()
}

func (s *SOCKS5Server) Listen() error {
	listener, err := net.Listen("tcp", s.listenAddr)
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		listener.Close()
		return net.ErrClosed
	}
	s.listener = listener
	utils.Debugf("[SOCKS5] Listening on %s", listener.Addr())
	return nil
}

func (s *SOCKS5Server) Serve() error {
	s.mu.Lock()
	listener := s.listener
	s.mu.Unlock()
	if listener == nil {
		return fmt.Errorf("Serve без Listen")
	}
	defer listener.Close()

	for {
		conn, err := listener.Accept()
		if err != nil {
			// Закрытый листенер - это Stop(), а не сбой. Без этой ветки цикл
			// крутится на мёртвом сокете и жжёт процессор: на телефоне такое
			// приложение система прибьёт.
			if errors.Is(err, net.ErrClosed) {
				utils.Debugf("[SOCKS5] Listener closed")
				return nil
			}
			utils.Debugf("[SOCKS5] Accept error: %v", err)
			continue
		}
		go s.handleConnection(conn)
	}
}

func (s *SOCKS5Server) handleConnection(clientConn net.Conn) {
	defer clientConn.Close()

	_ = clientConn.SetDeadline(time.Now().Add(15 * time.Second))
	targetAddr, err := readConnect(clientConn)
	if err != nil {
		return
	}
	_ = clientConn.SetDeadline(time.Time{})

	utils.Debugf("[SOCKS5] CONNECT %s", targetAddr)

	targetConn, err := s.dialer.DialTCP(targetAddr)
	if err != nil {
		utils.Debugf("[SOCKS5] Dial failed: %v", err)
		clientConn.Write([]byte{0x05, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00})
		return
	}
	defer targetConn.Close()

	clientConn.Write([]byte{0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00})

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		defer targetConn.Close()
		io.Copy(targetConn, clientConn)
	}()

	go func() {
		defer wg.Done()
		defer clientConn.Close()
		io.Copy(clientConn, targetConn)
	}()

	wg.Wait()
}

// SOCKS is a byte stream: reads can split or coalesce handshake and CONNECT.
func readConnect(conn net.Conn) (string, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(conn, header); err != nil {
		return "", err
	}
	if header[0] != 5 || header[1] == 0 {
		return "", errors.New("invalid greeting")
	}
	methods := make([]byte, int(header[1]))
	if _, err := io.ReadFull(conn, methods); err != nil {
		return "", err
	}
	allowed := false
	for _, method := range methods {
		if method == 0 {
			allowed = true
		}
	}
	if !allowed {
		_, _ = conn.Write([]byte{5, 255})
		return "", errors.New("unsupported authentication")
	}
	if _, err := conn.Write([]byte{5, 0}); err != nil {
		return "", err
	}
	request := make([]byte, 4)
	if _, err := io.ReadFull(conn, request); err != nil {
		return "", err
	}
	if request[0] != 5 || request[1] != 1 || request[2] != 0 {
		return "", errors.New("invalid CONNECT")
	}
	var host string
	switch request[3] {
	case 1, 4:
		size := 4
		if request[3] == 4 {
			size = 16
		}
		address := make([]byte, size)
		if _, err := io.ReadFull(conn, address); err != nil {
			return "", err
		}
		host = net.IP(address).String()
	case 3:
		length := make([]byte, 1)
		if _, err := io.ReadFull(conn, length); err != nil {
			return "", err
		}
		if length[0] == 0 {
			return "", errors.New("empty domain")
		}
		address := make([]byte, int(length[0]))
		if _, err := io.ReadFull(conn, address); err != nil {
			return "", err
		}
		host = string(address)
	default:
		return "", errors.New("unsupported address")
	}
	port := make([]byte, 2)
	if _, err := io.ReadFull(conn, port); err != nil {
		return "", err
	}
	number := binary.BigEndian.Uint16(port)
	if number == 0 {
		return "", errors.New("invalid port")
	}
	return net.JoinHostPort(host, strconv.Itoa(int(number))), nil
}
