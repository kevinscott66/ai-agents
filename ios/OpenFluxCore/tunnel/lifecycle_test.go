package tunnel

import (
	"testing"
	"universal-bypass-tool/transport"
)

type testTransport struct{ *transport.BaseTransport }

func (t testTransport) Send([]byte) error { return nil }
func TestClientStackCloseIsIdempotent(t *testing.T) {
	tr := transport.NewBaseTransport(transport.DefaultConfig())
	tun := NewTCPTunnel(testTransport{tr}, false)
	tun.Close()
	tun.Close()
	select {
	case <-tun.done:
	default:
		t.Fatal("statistics task not stopped")
	}
}
