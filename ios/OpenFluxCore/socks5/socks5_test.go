package socks5

import (
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func TestFragmentedLongDomain(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	_ = a.SetDeadline(time.Now().Add(time.Second))
	_ = b.SetDeadline(time.Now().Add(time.Second))
	done := make(chan error, 1)
	go func() {
		host, err := readConnect(a)
		if err == nil && host != strings.Repeat("a", 255)+":443" {
			t.Errorf("bad host: %q", host)
		}
		done <- err
	}()
	for _, v := range []byte{5, 1, 0} {
		if _, err := b.Write([]byte{v}); err != nil {
			t.Fatal(err)
		}
	}
	greeting := make([]byte, 2)
	if _, err := io.ReadFull(b, greeting); err != nil {
		t.Fatal(err)
	}
	req := append([]byte{5, 1, 0, 3, 255}, []byte(strings.Repeat("a", 255))...)
	req = append(req, 1, 187)
	for _, v := range req {
		if _, err := b.Write([]byte{v}); err != nil {
			t.Fatal(err)
		}
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
func TestUnsupportedAuthentication(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	_ = a.SetDeadline(time.Now().Add(time.Second))
	_ = b.SetDeadline(time.Now().Add(time.Second))
	done := make(chan error, 1)
	go func() { _, err := readConnect(a); done <- err }()
	_, _ = b.Write([]byte{5, 1, 2})
	r := make([]byte, 2)
	_, _ = io.ReadFull(b, r)
	if r[1] != 255 || <-done == nil {
		t.Fatal("unsupported auth accepted")
	}
}
