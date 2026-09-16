//go:build mobile

package main

// C-обвязка для iOS и Android: main() на этих платформах не вызывается, приложение
// линкуется со статическим архивом и дёргает эти функции напрямую.
//
// Все возвращаемые строки выделены через C.CString - вызывающая сторона обязана
// отдать их в OpenFluxFree, иначе течёт память.

/*
#include <stdlib.h>
*/
import "C"

import (
	"sync"
	"unsafe"

	"universal-bypass-tool/utils"
)

var (
	mobileMu     sync.Mutex
	mobileClient *client
)

//export OpenFluxSetDebug
func OpenFluxSetDebug(on C.int) {
	if on != 0 {
		utils.EnableDebug()
	}
}

// OpenFluxStart поднимает клиент и начинает принимать SOCKS5-соединения.
// Возвращает NULL при успехе, иначе текст ошибки.
//
//export OpenFluxStart
func OpenFluxStart(transportName, docURL, maxToken, maxUID, socksAddr, dns *C.char) *C.char {
	mobileMu.Lock()
	defer mobileMu.Unlock()

	if mobileClient != nil {
		return C.CString("клиент уже запущен")
	}

	cfg := clientConfig{
		Transport: C.GoString(transportName),
		DocURL:    C.GoString(docURL),
		MaxToken:  C.GoString(maxToken),
		MaxUID:    C.GoString(maxUID),
		SocksAddr: C.GoString(socksAddr),
		DNS:       C.GoString(dns),
	}
	if cfg.SocksAddr == "" {
		// Порт выбирает система: фиксированный на телефоне занимать незачем,
		// реальный адрес потом отдаёт OpenFluxSocksAddr.
		cfg.SocksAddr = "127.0.0.1:0"
	}
	if cfg.DNS == "" {
		cfg.DNS = "1.1.1.1:53"
	}

	cl, err := startClient(cfg)
	if err != nil {
		return C.CString(err.Error())
	}
	// Порт занимаем синхронно, чтобы вызывающий сразу мог спросить адрес.
	if err := cl.Listen(); err != nil {
		cl.Stop()
		return C.CString("SOCKS5: " + err.Error())
	}

	mobileClient = cl
	go cl.Serve()

	return nil
}

// OpenFluxSocksAddr - фактический адрес SOCKS5 ("127.0.0.1:54321") или пустая строка.
//
//export OpenFluxSocksAddr
func OpenFluxSocksAddr() *C.char {
	mobileMu.Lock()
	defer mobileMu.Unlock()

	if mobileClient == nil {
		return C.CString("")
	}
	return C.CString(mobileClient.SocksAddr())
}

//export OpenFluxIsRunning
func OpenFluxIsRunning() C.int {
	mobileMu.Lock()
	defer mobileMu.Unlock()

	if mobileClient == nil {
		return 0
	}
	return 1
}

//export OpenFluxStop
func OpenFluxStop() {
	mobileMu.Lock()
	cl := mobileClient
	mobileClient = nil
	mobileMu.Unlock()

	if cl != nil {
		cl.Stop()
	}
}

//export OpenFluxFree
func OpenFluxFree(p *C.char) {
	if p != nil {
		C.free(unsafe.Pointer(p))
	}
}
