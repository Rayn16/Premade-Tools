package main

// The link: phones use this PC through the Friends relay, with no Tailscale and no setup, at home or away. The phone
// app the iPhone opens is an https page on the relay, and such a page can't talk to the PC's plain home address,
// so the PC keeps a WebSocket open to the relay instead (relay/worker.js, Link) and answers phone calls over it.
// Calls only reach the phone routes and arrive from "relay", never loopback, so the PC window's routes stay closed.

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/websocket"
)

// linkURL is where phones reach this PC through the relay; empty until the relay is set up.
func (a *App) linkURL() string {
	c := a.set.Get()
	if c.LinkID == "" || strings.Contains(relayURL, "REPLACE") {
		return ""
	}
	return strings.TrimSuffix(relayURL, "/") + "/pc/" + c.LinkID
}

func (a *App) linkLoop() {
	if strings.Contains(relayURL, "REPLACE") {
		return
	}
	a.set.With(func(c *Config) bool { // made once: the id names this PC on the relay, the key proves it's this PC
		if c.LinkID != "" {
			return false
		}
		c.LinkID, c.LinkKey = randHex(16), randHex(32)
		return true
	})
	h := a.routes()
	for wait := time.Second; ; {
		t := time.Now()
		if err := a.linkOnce(h); err != nil {
			log.Printf("relay link: %v", err)
		}
		if time.Since(t) > time.Minute {
			wait = time.Second
		}
		time.Sleep(wait)
		wait = min(wait*2, 2*time.Minute)
	}
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

type linkMsg struct {
	T string            `json:"t"`
	N uint32            `json:"n"`
	M string            `json:"m,omitempty"`
	P string            `json:"p,omitempty"`
	H map[string]string `json:"h,omitempty"`
	B bool              `json:"b,omitempty"`
	S int               `json:"s,omitempty"`
}

type link struct {
	ws    *websocket.Conn
	wmu   sync.Mutex
	mu    sync.Mutex
	calls map[uint32]*linkCall
}

type linkCall struct {
	acks   chan struct{}
	cancel context.CancelFunc
}

func (l *link) send(v any) error {
	l.wmu.Lock()
	defer l.wmu.Unlock()
	switch v := v.(type) {
	case []byte:
		return websocket.Message.Send(l.ws, v)
	case string:
		return websocket.Message.Send(l.ws, v)
	default:
		return websocket.JSON.Send(l.ws, v)
	}
}

func (a *App) linkOnce(h http.Handler) error {
	c := a.set.Get()
	base := strings.TrimSuffix(relayURL, "/") + "/pc/" + c.LinkID
	cfg, err := websocket.NewConfig("ws"+strings.TrimPrefix(base, "http")+"/link", relayURL)
	if err != nil {
		return err
	}
	cfg.Header.Set("Authorization", "Bearer "+c.LinkKey)
	ws, err := websocket.DialConfig(cfg)
	if err != nil {
		return err
	}
	defer ws.Close()
	l := &link{ws: ws, calls: map[uint32]*linkCall{}}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() { // the relay answers "ping" itself, so this keeps the link up without waking it
		for t := time.NewTicker(30 * time.Second); ; {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				l.send("ping")
			}
		}
	}()
	for {
		ws.SetReadDeadline(time.Now().Add(90 * time.Second))
		var raw string
		if err := websocket.Message.Receive(ws, &raw); err != nil {
			return err
		}
		if raw == "pong" {
			continue
		}
		var m linkMsg
		if json.Unmarshal([]byte(raw), &m) != nil {
			continue
		}
		l.mu.Lock()
		call := l.calls[m.N]
		l.mu.Unlock()
		switch m.T {
		case "req":
			cctx, cancel := context.WithCancel(ctx)
			call := &linkCall{acks: make(chan struct{}, linkWindow), cancel: cancel}
			l.mu.Lock()
			l.calls[m.N] = call
			l.mu.Unlock()
			go func() {
				defer func() {
					cancel()
					l.mu.Lock()
					delete(l.calls, m.N)
					l.mu.Unlock()
				}()
				l.serve(cctx, h, base, c.LinkKey, m, call)
			}()
		case "ack":
			if call != nil {
				select {
				case call.acks <- struct{}{}:
				default:
				}
			}
		case "stop":
			if call != nil {
				call.cancel()
			}
		}
	}
}

const (
	linkPiece  = 256 << 10
	linkWindow = 8 // pieces on the way before the PC waits for the phone to take them
)

func (l *link) serve(ctx context.Context, h http.Handler, base, key string, m linkMsg, call *linkCall) {
	w := &linkWriter{l: l, n: m.N, call: call, ctx: ctx, h: http.Header{}}
	if !strings.HasPrefix(m.P, "/api/phone/") {
		http.Error(w, "not here", 404)
		w.finish()
		return
	}
	var body io.ReadCloser = http.NoBody
	if m.B { // the phone's upload, pulled from the relay as it arrives
		req, _ := http.NewRequestWithContext(ctx, "GET", base+"/body/"+strconv.FormatUint(uint64(m.N), 10), nil)
		req.Header.Set("Authorization", "Bearer "+key)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			l.send(linkMsg{T: "err", N: m.N})
			return
		}
		body = res.Body
	}
	defer body.Close()
	r, err := http.NewRequestWithContext(ctx, m.M, "http://relay"+m.P, body)
	if err != nil {
		l.send(linkMsg{T: "err", N: m.N})
		return
	}
	for k, v := range m.H {
		r.Header.Set(k, v)
	}
	r.ContentLength, _ = strconv.ParseInt(r.Header.Get("Content-Length"), 10, 64)
	if !m.B {
		r.ContentLength = 0
	}
	r.RemoteAddr = "relay:0" // not loopback: the PC window's routes say no
	h.ServeHTTP(w, r)
	w.finish()
}

// linkWriter sends a handler's answer to the relay: the status and headers, then the body in pieces.
type linkWriter struct {
	l      *link
	n      uint32
	call   *linkCall
	ctx    context.Context
	h      http.Header
	sent   bool
	out    int // pieces sent and not yet taken
	failed bool
}

func (w *linkWriter) Header() http.Header { return w.h }

func (w *linkWriter) WriteHeader(s int) {
	if w.sent {
		return
	}
	w.sent = true
	hs := map[string]string{}
	for k := range w.h {
		hs[strings.ToLower(k)] = w.h.Get(k)
	}
	if w.l.send(linkMsg{T: "res", N: w.n, S: s, H: hs}) != nil {
		w.failed = true
	}
}

func (w *linkWriter) Write(p []byte) (int, error) {
	if !w.sent {
		if w.h.Get("Content-Type") == "" {
			w.h.Set("Content-Type", http.DetectContentType(p))
		}
		w.WriteHeader(200)
	}
	done := 0
	for len(p) > 0 {
		if w.failed {
			return done, io.ErrClosedPipe
		}
		for w.out >= linkWindow {
			select {
			case <-w.call.acks:
				w.out--
			case <-w.ctx.Done():
				w.failed = true
				return done, w.ctx.Err()
			case <-time.After(2 * time.Minute):
				w.failed = true
				return done, io.ErrClosedPipe
			}
		}
		k := min(len(p), linkPiece)
		frame := make([]byte, 4+k)
		binary.BigEndian.PutUint32(frame, w.n)
		copy(frame[4:], p[:k])
		if w.l.send(frame) != nil {
			w.failed = true
			return done, io.ErrClosedPipe
		}
		w.out++
		done += k
		p = p[k:]
	}
	return done, nil
}

func (w *linkWriter) Flush() {}

func (w *linkWriter) finish() {
	if !w.sent {
		w.WriteHeader(200)
	}
	if w.failed {
		w.l.send(linkMsg{T: "err", N: w.n})
		return
	}
	w.l.send(linkMsg{T: "end", N: w.n})
}
