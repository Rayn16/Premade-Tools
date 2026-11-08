package main

// Away from home, phones reach this PC through Tailscale. The phone pages live on the Friends relay (https), and an
// https page may only talk to https, so the PC asks Tailscale for a free certificate for its ts.net name and
// answers there too, on its own port. Requests over it come from the phone's Tailscale address, never loopback,
// so the PC window's routes stay closed to them.

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const tsPort = port + 1

type tailscale struct {
	mu    sync.Mutex
	url   string // https://pc.tailnet.ts.net:47111 once it answers
	ip    string // 100.x.y.z:47110, the plain address the Android app uses (it may use http; pages from the relay may not)
	state string // "off" (not installed or signed out), "nohttps" (HTTPS certificates off for the tailnet), "ok"
	cert  *tls.Certificate
	ln    bool
}

func tsExe() string {
	if p, err := exec.LookPath("tailscale"); err == nil {
		return p
	}
	p := filepath.Join(os.Getenv("ProgramFiles"), "Tailscale", "tailscale.exe")
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return ""
}

// Status is what the PC window's guide and the phones show.
func (t *tailscale) Status() (url, state string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.url, t.state
}

func (t *tailscale) IP() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.ip
}

func (a *App) tsLoop() {
	for {
		wait := 6 * time.Hour // certificates last 90 days; Tailscale renews them when asked again
		if a.ts.setup(a) != "ok" {
			wait = 2 * time.Minute
		}
		time.Sleep(wait)
	}
}

func (t *tailscale) set(url, state string) string {
	t.mu.Lock()
	t.url, t.state = url, state
	t.mu.Unlock()
	return state
}

func (t *tailscale) setup(a *App) string {
	exe := tsExe()
	if exe == "" {
		return t.set("", "off")
	}
	out, err := hidden(exec.Command(exe, "status", "--json")).Output()
	var st struct {
		BackendState string
		Self         struct {
			DNSName      string
			TailscaleIPs []string
		}
	}
	if err != nil || json.Unmarshal(out, &st) != nil || st.BackendState != "Running" || st.Self.DNSName == "" {
		t.mu.Lock()
		t.ip = ""
		t.mu.Unlock()
		return t.set("", "off")
	}
	t.mu.Lock()
	t.ip = ""
	for _, ip := range st.Self.TailscaleIPs {
		if !strings.Contains(ip, ":") {
			t.ip = fmt.Sprintf("%s:%d", ip, port)
		}
	}
	t.mu.Unlock()
	name := strings.TrimSuffix(st.Self.DNSName, ".")
	crt, key := filepath.Join(appDir(), "ts.crt"), filepath.Join(appDir(), "ts.key")
	if out, err := hidden(exec.Command(exe, "cert", "--cert-file", crt, "--key-file", key, name)).CombinedOutput(); err != nil {
		log.Printf("tailscale cert: %v %s", err, out)
		return t.set("", "nohttps")
	}
	c, err := tls.LoadX509KeyPair(crt, key)
	if err != nil {
		log.Printf("tailscale cert: %v", err)
		return t.set("", "nohttps")
	}
	t.mu.Lock()
	t.cert = &c
	start := !t.ln
	t.ln = true
	t.mu.Unlock()
	if start {
		srv := &http.Server{Addr: fmt.Sprintf(":%d", tsPort), Handler: withCORS(a.routes()), TLSConfig: &tls.Config{GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			t.mu.Lock()
			defer t.mu.Unlock()
			return t.cert, nil
		}}}
		go func() {
			err := srv.ListenAndServeTLS("", "")
			log.Printf("tailscale https: %v", err)
			t.mu.Lock()
			t.ln = false
			t.mu.Unlock()
		}()
	}
	return t.set(fmt.Sprintf("https://%s:%d", name, tsPort), "ok")
}

// withCORS lets the phone pages on the relay call this PC's phone routes. Every one of them still needs a phone's key.
func withCORS(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); o != "" && o == strings.TrimSuffix(relayURL, "/") && strings.HasPrefix(r.URL.Path, "/api/phone/") {
			w.Header().Set("Access-Control-Allow-Origin", o)
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Key, X-Name")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT")
			w.Header().Set("Access-Control-Allow-Private-Network", "true")
			if r.Method == "OPTIONS" {
				w.WriteHeader(204)
				return
			}
		}
		h.ServeHTTP(w, r)
	})
}
