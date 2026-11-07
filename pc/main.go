// Premade Tools for Windows: the Vault keeps every file deleted on your phones.
// It runs quietly at low priority, takes uploads from paired phones on the home network,
// and opens its screens in a light Edge app window when you start it.
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var version = "0.1.0" // CI sets the build number: -X main.version=0.1.N
const port = 47110

var listener net.Listener

type App struct {
	set    *Settings
	mu     sync.Mutex
	store  *Store // nil until setup picks a vault folder
	pairs  map[string]time.Time
	warn   map[string]time.Time // last time each warning was shown as a Windows notification
	upd    string               // newer version waiting, if any
	moving bool
	health string // vault drive health, "" when unknown
	eng    *Engines
	dl     *Downloader
	cv     *Converter
	pdf    *Converter // the PDF tools, on the Converter's queue
}

func main() {
	background := flag.Bool("background", false, "start without opening the window (used when Windows starts)")
	flag.Parse()
	os.MkdirAll(appDir(), 0o755)
	if lf, err := os.OpenFile(filepath.Join(appDir(), "vault.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
		log.SetOutput(lf)
	}

	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		// Already running: just show its window.
		if !*background {
			openWindow(fmt.Sprintf("http://127.0.0.1:%d/", port))
		}
		return
	}
	if installSelf(os.Args[1:], func() { ln.Close() }) {
		return
	}
	listener = ln
	lowPriority()
	cleanOldExe()

	a := &App{set: LoadSettings(), pairs: map[string]time.Time{}, warn: map[string]time.Time{}}
	a.eng = NewEngines(func() bool { return a.set.Get().DlNightly })
	a.dl = NewDownloader(a.eng, func() string { return a.set.Get().DownloadDir() })
	a.cv = NewConverter(a.cvBin, func() string { return a.set.Get().ConvertDir() })
	a.pdf = NewPdfTools(func() string { return a.set.Get().PdfOutDir() })
	if c := a.set.Get(); c.VaultDir != "" {
		if a.store, err = OpenStore(c.VaultDir); err != nil {
			log.Printf("vault at %s: %v", c.VaultDir, err)
		}
		setAutostart(c.StartWin)
	}
	go a.loop()
	if !*background {
		go openWindow(fmt.Sprintf("http://127.0.0.1:%d/", port))
	}
	log.Printf("Premade Tools %s on :%d", version, port)
	log.Fatal(http.Serve(ln, a.routes()))
}

func (a *App) getStore() *Store {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.store
}

// loop does the slow chores: clearing old files, drive health, warnings, updates.
func (a *App) loop() {
	tick := 0
	for {
		c := a.set.Get()
		if st := a.getStore(); st != nil {
			if d, ok := keepDur[c.Keep]; ok {
				if err := st.Clear(time.Now().Add(-d)); err != nil {
					log.Printf("clear: %v", err)
				}
			}
			if tick%6 == 0 {
				h := driveHealth(c.VaultDir)
				a.mu.Lock()
				a.health = h
				a.mu.Unlock()
			}
			for _, w := range a.warnings() {
				a.mu.Lock()
				due := time.Since(a.warn[w]) > 24*time.Hour
				if due {
					a.warn[w] = time.Now()
				}
				a.mu.Unlock()
				if due {
					notify("Vault", w)
				}
			}
		}
		if tick%6 == 0 {
			a.findUpdate()
		}
		a.eng.Update(false) // installs missing engines, refreshes the ones that are due
		tick++
		time.Sleep(time.Hour)
	}
}

// warnings lists what needs attention right now.
func (a *App) warnings() []string {
	c := a.set.Get()
	var out []string
	if c.WarnPhone {
		for _, p := range c.Phones {
			if time.Since(p.LastSeen) > 72*time.Hour {
				out = append(out, p.Name+" hasn't checked in for 3 days.")
			}
		}
	}
	if c.VaultDir != "" {
		if free, total := diskSpace(c.VaultDir); c.WarnSpace && total > 0 && (free < 20<<30 || free*20 < total) {
			out = append(out, fmt.Sprintf("The vault drive is nearly full: %s free.", human(int64(free))))
		}
		a.mu.Lock()
		h := a.health
		a.mu.Unlock()
		if c.WarnHealth && h != "" && h != "Healthy" {
			out = append(out, "The vault drive reports its health as "+h+". Copy the vault to another drive soon.")
		}
	}
	return out
}

func human(b int64) string {
	switch {
	case b >= 1<<30:
		return fmt.Sprintf("%.0f GB", float64(b)/(1<<30))
	case b >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(b)/(1<<20))
	case b >= 1<<10:
		return fmt.Sprintf("%.0f KB", float64(b)/(1<<10))
	}
	return fmt.Sprintf("%d B", b)
}
