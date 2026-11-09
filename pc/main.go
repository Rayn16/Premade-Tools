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
	set     *Settings
	mu      sync.Mutex
	store   *Store // nil until setup picks a vault folder
	pairs   map[string]time.Time
	warn    map[string]time.Time // last time each warning was shown as a Windows notification
	upd     string               // newer version waiting, if any
	updErr  string               // why the last Update now failed
	moving  *moveSnap            // set while the vault moves: what the screens show meanwhile
	noVault string               // why the vault folder can't be opened right now
	health  string               // vault drive health, "" when unknown
	eng     *Engines
	dl      *Downloader
	cv      *Converter
	pdf     *Converter // the PDF tools, on the Converter's queue
	tr      *Converter // Transcribe, on the Converter's queue
	drops   *Drops
	fr      *Friends
	ts      tailscale
	clipSeq uint32 // Windows' clipboard counter when File drop last looked
}

func main() {
	background := flag.Bool("background", false, "start without opening the window (used when Windows starts)")
	page := flag.String("open", "", "open the window on this page (a clicked notification)")
	restarted := flag.Bool("restarted", false, "started by an update: wait for the old copy to let go of the port")
	flag.Parse()
	os.MkdirAll(appDir(), 0o755)
	if lf, err := os.OpenFile(filepath.Join(appDir(), "vault.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
		log.SetOutput(lf)
	}

	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	for try := 0; err != nil && *restarted && try < 30; try++ {
		time.Sleep(500 * time.Millisecond)
		ln, err = net.Listen("tcp", fmt.Sprintf(":%d", port))
	}
	if err != nil {
		// Already running: just show its window.
		if !*background {
			openWindow(fmt.Sprintf("http://127.0.0.1:%d/", port) + map[bool]string{true: "#" + *page}[*page != ""])
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
	a.cv = NewConverter(a.cvBin, func() string { return a.set.Get().DownloadDir() })
	a.pdf = NewPdfTools(func() string { return a.set.Get().DownloadDir() })
	a.tr = NewTranscriber(func() string { return a.cvBin("ffmpeg") }, func() string { return a.set.Get().DownloadDir() })
	a.drops = NewDrops(func() string { return a.set.Get().DownloadDir() })
	a.fr = NewFriends(a)
	go a.watchClip()
	go a.tsLoop()
	go a.linkLoop()
	if c := a.set.Get(); c.VaultDir != "" {
		a.openVault()
		setAutostart(c.StartWin)
	}
	go func() { // a vault that couldn't be opened (its drive plugged in late, say) comes back by itself
		for range time.Tick(30 * time.Second) {
			a.openVault()
		}
	}()
	go a.loop()
	if !*background {
		go openWindow(fmt.Sprintf("http://127.0.0.1:%d/", port))
	}
	log.Printf("Premade Tools %s on :%d", version, port)
	log.Fatal(http.Serve(ln, withCORS(a.routes())))
}

func (a *App) getStore() *Store {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.store
}

// openVault opens the vault folder when it isn't open yet, and keeps why it can't be for warnings().
func (a *App) openVault() {
	dir := a.set.Get().VaultDir
	if dir == "" || a.getStore() != nil {
		return
	}
	st, err := OpenStore(dir)
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.store != nil || a.set.Get().VaultDir != dir { // set up from the window meanwhile
		return
	}
	if err != nil {
		if a.noVault != err.Error() {
			log.Printf("vault at %s: %v", dir, err)
		}
		a.noVault = err.Error()
		return
	}
	a.store, a.noVault = st, ""
}

func (a *App) isMoving() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.moving != nil
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
		a.drops.Clear(time.Now())
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
	a.mu.Lock()
	verr, st := a.noVault, a.store
	a.mu.Unlock()
	if st != nil {
		for _, p := range c.Phones {
			if n := st.Held(p.ID); n > 0 {
				out = append(out, fmt.Sprintf("%s's last backup left out %d photos the vault keeps for it, so they don't show as deleted. Open Premade on that iPhone to check.", p.Name, n))
			}
		}
	}
	if verr != "" {
		out = append(out, "Can't open the vault in "+c.VaultDir+": "+verr+". Plug in its drive, or pick another folder in Settings.")
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
