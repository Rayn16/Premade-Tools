package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"embed"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

//go:embed ui
var uiFiles embed.FS

// The Android app ships inside the PC program, so the pairing page can hand it straight to the phone.
//
//go:embed apk
var apkFile embed.FS

func (a *App) routes() http.Handler {
	m := http.NewServeMux()
	ui, _ := fs.Sub(uiFiles, "ui")
	static := http.FileServer(http.FS(ui))

	// The PC's own window. Only this PC may load it.
	m.Handle("GET /", localOnly(static))
	// Pairing page a phone opens from the QR code, and the APK it installs.
	m.HandleFunc("GET /pair/{code}", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFileFS(w, r, ui, "pair.html")
	})
	m.Handle("GET /pt.css", static)
	m.Handle("GET /dl.css", static)
	m.Handle("GET /cv.css", static)
	m.Handle("GET /pdf.css", static)
	m.Handle("GET /tr.css", static)
	m.Handle("GET /drop.css", static)
	m.Handle("GET /friends.css", static)
	m.HandleFunc("GET /download/PremadeTools.apk", func(w http.ResponseWriter, r *http.Request) {
		b, err := apkFile.ReadFile("apk/PremadeTools.apk")
		if err != nil {
			http.Error(w, "This build of the PC program has no Android app inside.", 404)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.android.package-archive")
		w.Header().Set("Content-Disposition", `attachment; filename="PremadeTools.apk"`)
		w.Write(b)
	})
	m.HandleFunc("POST /api/pair", a.pair)

	ui2 := func(p string, h http.HandlerFunc) { m.Handle(p, localOnly(h)) }
	ui2("GET /api/ui/state", a.state)
	ui2("GET /api/ui/deleted", func(w http.ResponseWriter, r *http.Request) {
		if st := a.getStore(); st != nil {
			writeJ(w, st.Deleted())
		} else {
			writeJ(w, []Item{})
		}
	})
	ui2("GET /api/ui/file/{id}", a.uiFile)
	ui2("POST /api/ui/save/{id}", a.saveToPC)
	ui2("POST /api/ui/restore/{id}", a.queueRestore)
	ui2("POST /api/ui/dismiss/{id}", func(w http.ResponseWriter, r *http.Request) {
		if st := a.getStore(); st != nil {
			st.Dismiss(r.PathValue("id"))
		}
		writeJ(w, "ok")
	})
	ui2("GET /api/ui/drives", func(w http.ResponseWriter, r *http.Request) { writeJ(w, drives()) })
	ui2("POST /api/ui/pickfolder", func(w http.ResponseWriter, r *http.Request) { writeJ(w, map[string]string{"dir": pickFolder()}) })
	ui2("POST /api/ui/vault", a.setVault)
	ui2("POST /api/ui/settings", a.saveSettings)
	ui2("GET /api/ui/keep-preview", func(w http.ResponseWriter, r *http.Request) {
		n, b := 0, int64(0)
		if d, ok := keepDur[r.URL.Query().Get("keep")]; ok && a.getStore() != nil {
			n, b = a.getStore().Expired(time.Now().Add(-d))
		}
		writeJ(w, map[string]any{"count": n, "size": human(b)})
	})
	ui2("GET /api/ui/pair", a.newPair)
	ui2("POST /api/ui/forget/{id}", func(w http.ResponseWriter, r *http.Request) {
		a.set.With(func(c *Config) bool {
			for i, p := range c.Phones {
				if p.ID == r.PathValue("id") {
					c.Phones = append(c.Phones[:i], c.Phones[i+1:]...)
					return true
				}
			}
			return false
		})
		writeJ(w, "ok")
	})
	ui2("POST /api/ui/update", func(w http.ResponseWriter, r *http.Request) {
		writeJ(w, map[string]string{"msg": a.checkUpdate()})
	})

	// Paired phones.
	ph := func(p string, h func(http.ResponseWriter, *http.Request, *Phone, *Store)) {
		m.HandleFunc(p, a.phoneAuth(h))
	}
	ph("POST /api/phone/checkin", a.checkin)
	ph("GET /api/phone/have", func(w http.ResponseWriter, r *http.Request, p *Phone, st *Store) {
		writeJ(w, map[string]bool{"have": st.Has(p.ID, r.URL.Query().Get("key"))})
	})
	ph("PUT /api/phone/upload", a.upload)
	ph("POST /api/phone/missed", func(w http.ResponseWriter, r *http.Request, p *Phone, st *Store) {
		var in struct {
			Name, Folder, Note string
			At                 int64
		}
		if json.NewDecoder(r.Body).Decode(&in) != nil || in.Name == "" {
			http.Error(w, "bad request", 400)
			return
		}
		st.AddMissed(Item{Key: in.Folder + "/" + in.Name, Name: in.Name, Folder: in.Folder, Phone: p.ID, Note: in.Note, DeletedAt: msTime(in.At)})
		writeJ(w, "ok")
	})
	ph("POST /api/phone/list", func(w http.ResponseWriter, r *http.Request, p *Phone, st *Store) {
		var in struct {
			Keys     []string `json:"keys"`
			Complete bool     `json:"complete"`
		}
		if json.NewDecoder(r.Body).Decode(&in) != nil {
			http.Error(w, "bad request", 400)
			return
		}
		keys := in.Keys
		if !in.Complete {
			keys = nil // a partial list only asks what's missing; it never marks anything deleted
		}
		need, err := st.SyncPhoneList(p.ID, keys, time.Now())
		if !in.Complete {
			for _, k := range in.Keys {
				if !st.Has(p.ID, k) {
					need = append(need, k)
				}
			}
		}
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeJ(w, map[string]any{"need": need})
	})
	// The iPhone's Shortcut speaks plain text: it sends the names of every photo and video on the phone,
	// one per line, and gets back the ones the PC still needs as "|name|name|" so an If "contains" can test each.
	ph("POST /api/phone/ios/backup", func(w http.ResponseWriter, r *http.Request, p *Phone, st *Store) {
		b, _ := io.ReadAll(io.LimitReader(r.Body, 16<<20))
		var keys []string
		for _, l := range strings.Split(string(b), "\n") {
			if l = strings.TrimSpace(l); l != "" {
				keys = append(keys, l)
			}
		}
		if len(keys) == 0 { // Photos access off or the list didn't arrive: never read that as "everything was deleted"
			http.Error(w, "The Shortcut sent no photo names. Check it can see your photos.", 400)
			return
		}
		a.touch(p.ID)
		need, err := st.SyncPhoneList(p.ID, keys, time.Now())
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprint(w, "|"+strings.Join(need, "|")+"|")
	})
	// Files the PC wants back in the iPhone's Photos, one id per line ("none" when there are none).
	ph("GET /api/phone/ios/restores", func(w http.ResponseWriter, r *http.Request, p *Phone, st *Store) {
		var ids []string
		for _, id := range p.Restores {
			if st.Get(id) != nil {
				ids = append(ids, id)
			}
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		if len(ids) == 0 {
			fmt.Fprint(w, "none")
			return
		}
		fmt.Fprint(w, strings.Join(ids, "\n"))
	})
	ph("GET /api/phone/restores", func(w http.ResponseWriter, r *http.Request, p *Phone, st *Store) {
		out := []Item{}
		for _, id := range p.Restores {
			if it := st.Get(id); it != nil {
				out = append(out, *it)
			}
		}
		writeJ(w, out)
	})
	ph("GET /api/phone/file/{id}", func(w http.ResponseWriter, r *http.Request, p *Phone, st *Store) {
		serveItem(w, r, st, r.PathValue("id"), true)
	})
	ph("POST /api/phone/restored/{id}", func(w http.ResponseWriter, r *http.Request, p *Phone, st *Store) {
		a.set.With(func(c *Config) bool {
			for _, q := range c.Phones {
				if q.ID == p.ID {
					q.Restores = without(q.Restores, r.PathValue("id"))
				}
			}
			return true
		})
		writeJ(w, "ok")
	})
	// The phone screens (Android app and iPhone home-screen app), served from this PC so both stay in step.
	m.Handle("GET /m/", static)
	m.Handle("GET /icon.svg", static)
	ph("GET /api/phone/state", func(w http.ResponseWriter, r *http.Request, p *Phone, st *Store) {
		c := a.set.Get()
		free, _ := diskSpace(c.VaultDir)
		remote, tsState := a.ts.Status()
		writeJ(w, map[string]any{"me": p.ID, "phones": a.phoneViews(), "version": version, "remote": remote, "tailscale": tsState, "relay": relayURL, "link": a.linkURL(), "fr": c.FrTok, "tsHost": a.ts.IP(), "update": a.newVer(), "updErr": a.updFailed(), "free": human(int64(free)),
			"config": map[string]any{"keep": c.Keep, "theme": c.Theme, "custom": c.Custom, "vaultDir": c.VaultDir}})
	})
	ph("POST /api/phone/update", func(w http.ResponseWriter, r *http.Request, p *Phone, st *Store) {
		writeJ(w, map[string]string{"msg": a.checkUpdate()})
	})
	ph("GET /api/phone/app", func(w http.ResponseWriter, r *http.Request, p *Phone, st *Store) {
		v, _ := apkFile.ReadFile("apk/version.txt")
		n, _ := strconv.Atoi(strings.TrimSpace(string(v)))
		writeJ(w, map[string]int{"version": n})
	})
	ph("GET /api/phone/deleted", func(w http.ResponseWriter, r *http.Request, p *Phone, st *Store) { writeJ(w, st.Deleted()) })
	ph("GET /api/phone/view/{id}", func(w http.ResponseWriter, r *http.Request, p *Phone, st *Store) {
		serveItem(w, r, st, r.PathValue("id"), r.URL.Query().Has("dl"))
	})
	ph("POST /api/phone/restore/{id}", func(w http.ResponseWriter, r *http.Request, p *Phone, st *Store) { a.queueRestore(w, r) })
	ph("POST /api/phone/dismiss/{id}", func(w http.ResponseWriter, r *http.Request, p *Phone, st *Store) {
		st.Dismiss(r.PathValue("id"))
		writeJ(w, "ok")
	})
	ph("GET /api/phone/keep-preview", func(w http.ResponseWriter, r *http.Request, p *Phone, st *Store) {
		n, b := 0, int64(0)
		if d, ok := keepDur[r.URL.Query().Get("keep")]; ok {
			n, b = st.Expired(time.Now().Add(-d))
		}
		writeJ(w, map[string]any{"count": n, "size": human(b)})
	})
	ph("POST /api/phone/settings", func(w http.ResponseWriter, r *http.Request, p *Phone, st *Store) {
		var in map[string]json.RawMessage
		json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in)
		out := map[string]json.RawMessage{}
		for _, k := range []string{"keep", "theme", "custom", "clipSync"} { // a phone may change only these
			if v, ok := in[k]; ok {
				out[k] = v
			}
		}
		b, _ := json.Marshal(out)
		r.Body = io.NopCloser(bytes.NewReader(b))
		a.saveSettings(w, r)
	})
	a.dlRoutes(m)
	a.cvRoutes(m)
	a.pdfRoutes(m)
	a.trRoutes(m)
	a.friendsRoutes(m)
	a.dropRoutes(m)
	return m
}

// localOnly lets only this PC's own window through. The Host check stops DNS-rebinding pages,
// and the X-Vault header on API calls stops other web pages from posting to us.
func localOnly(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		okHost := r.Host == fmt.Sprintf("127.0.0.1:%d", port) || r.Host == fmt.Sprintf("localhost:%d", port)
		if !net.ParseIP(host).IsLoopback() || !okHost {
			http.Error(w, "This page only opens on the PC itself.", 403)
			return
		}
		// Previews load through <img>/<video>, which can't send headers; reads can't change anything.
		preview := r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/api/ui/file/")
		if strings.HasPrefix(r.URL.Path, "/api/") && !preview && r.Header.Get("X-Vault") != "1" {
			http.Error(w, "forbidden", 403)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func (a *App) phoneAuth(h func(http.ResponseWriter, *http.Request, *Phone, *Store)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if tok == "" {
			tok = r.URL.Query().Get("t") // previews in <img>/<video> can't send headers
		}
		var p *Phone
		for _, q := range a.set.Get().Phones {
			if tok != "" && q.Token == tok {
				p = q
			}
		}
		if p == nil {
			http.Error(w, "not paired", 401)
			return
		}
		st := a.getStore()
		if st == nil || a.moving {
			http.Error(w, "vault not ready", 503)
			return
		}
		h(w, r, p, st)
	}
}

func writeJ(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func randCode(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b))
}

func msTime(ms int64) time.Time {
	if ms <= 0 {
		return time.Now()
	}
	return time.UnixMilli(ms)
}

func without(list []string, s string) []string {
	out := list[:0]
	for _, x := range list {
		if x != s {
			out = append(out, x)
		}
	}
	return out
}

type phoneView struct {
	Pending          []string // restores still on their way to the phone
	ID, Name, Kind   string
	Paired, LastSeen time.Time
	Status           json.RawMessage
	Restores         int
}

func (a *App) phoneViews() []phoneView {
	phones := []phoneView{}
	for _, p := range a.set.Get().Phones {
		phones = append(phones, phoneView{append([]string{}, p.Restores...), p.ID, p.Name, p.Kind, p.Paired, p.LastSeen, p.Status, len(p.Restores)})
	}
	return phones
}

func (a *App) newVer() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.upd
}

func (a *App) state(w http.ResponseWriter, r *http.Request) {
	c := a.set.Get()
	phones := a.phoneViews()
	c.Phones = nil
	remote, tsState := a.ts.Status()
	out := map[string]any{"config": c, "phones": phones, "version": version, "warnings": a.warnings(), "update": a.newVer(), "updErr": a.updFailed(), "moving": a.moving, "remote": remote, "tailscale": tsState}
	if st := a.getStore(); st != nil {
		n, b := st.Stats()
		free, _ := diskSpace(c.VaultDir)
		out["count"], out["bytes"], out["free"] = n, human(b), human(int64(free))
	}
	writeJ(w, out)
}

func (a *App) setVault(w http.ResponseWriter, r *http.Request) {
	var in struct{ Dir string }
	json.NewDecoder(r.Body).Decode(&in)
	dir := filepath.Clean(strings.TrimSpace(in.Dir))
	if in.Dir == "" || !filepath.IsAbs(dir) {
		http.Error(w, "Pick a full folder path, like D:\\Premade Vault.", 400)
		return
	}
	old := a.set.Get().VaultDir
	if old == "" || old == dir {
		st, err := OpenStore(dir)
		if err != nil {
			http.Error(w, "Can't use that folder: "+err.Error(), 400)
			return
		}
		a.mu.Lock()
		a.store = st
		a.mu.Unlock()
		a.set.With(func(c *Config) bool { c.VaultDir = dir; return true })
		setAutostart(a.set.Get().StartWin)
		writeJ(w, "ok")
		return
	}
	if strings.HasPrefix(dir+string(os.PathSeparator), old+string(os.PathSeparator)) {
		http.Error(w, "The new folder can't be inside the old one.", 400)
		return
	}
	go a.moveVault(old, dir)
	writeJ(w, "moving")
}

// moveVault copies everything to the new folder, switches over, then removes the old copy.
func (a *App) moveVault(old, dir string) {
	a.mu.Lock()
	a.moving = true
	st := a.store
	a.mu.Unlock()
	st.mu.Lock() // holds uploads until the move is done
	err := filepath.Walk(old, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(old, p)
		dst := filepath.Join(dir, rel)
		if fi.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		return copyFile(p, dst)
	})
	if err == nil {
		st.dir = dir
		a.set.With(func(c *Config) bool { c.VaultDir = dir; return true })
		os.RemoveAll(filepath.Join(old, "objects"))
		os.Remove(filepath.Join(old, "index.json"))
		os.RemoveAll(filepath.Join(old, "tmp"))
		os.Remove(old)
	} else {
		notify("Vault", "Couldn't move the vault: "+err.Error()+". It stays where it was.")
	}
	st.mu.Unlock()
	a.mu.Lock()
	a.moving = false
	a.mu.Unlock()
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	n, err := io.Copy(out, in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if fi, _ := in.Stat(); err == nil && fi.Size() != n {
		err = fmt.Errorf("%s copied short", src)
	}
	return err
}

func (a *App) saveSettings(w http.ResponseWriter, r *http.Request) {
	var in map[string]json.RawMessage
	if json.NewDecoder(r.Body).Decode(&in) != nil {
		http.Error(w, "bad request", 400)
		return
	}
	var err error
	a.set.With(func(c *Config) bool {
		// Only these fields can be changed from the window; phones and the vault path have their own calls.
		for k, v := range in {
			switch k {
			case "keep":
				var s string
				json.Unmarshal(v, &s)
				if _, ok := keepDur[s]; ok || s == "forever" {
					c.Keep = s
				}
			case "spaceSaver":
				json.Unmarshal(v, &c.SpaceSaver)
			case "theme":
				json.Unmarshal(v, &c.Theme)
			case "custom":
				json.Unmarshal(v, &c.Custom)
			case "size":
				json.Unmarshal(v, &c.Size)
			case "warnPhone":
				json.Unmarshal(v, &c.WarnPhone)
			case "warnHealth":
				json.Unmarshal(v, &c.WarnHealth)
			case "warnSpace":
				json.Unmarshal(v, &c.WarnSpace)
			case "setupDone":
				json.Unmarshal(v, &c.SetupDone)
			case "clipSync":
				json.Unmarshal(v, &c.ClipSync)
			case "startWin":
				json.Unmarshal(v, &c.StartWin)
				err = setAutostart(c.StartWin)
			}
		}
		return true
	})
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if c := a.set.Get(); keepDur[c.Keep] > 0 && a.getStore() != nil {
		go a.getStore().Clear(time.Now().Add(-keepDur[c.Keep]))
	}
	writeJ(w, "ok")
}

func (a *App) newPair(w http.ResponseWriter, r *http.Request) {
	code := randCode(10)
	a.mu.Lock()
	a.pairs[code] = time.Now().Add(15 * time.Minute)
	a.mu.Unlock()
	link := fmt.Sprintf("http://%s:%d/pair/%s", lanIP(), port, code)
	png, _ := qrcode.Encode(link, qrcode.Medium, 512)
	writeJ(w, map[string]string{"url": link, "qr": "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)})
}

// pair turns a fresh QR code into a lasting key for one phone.
func (a *App) pair(w http.ResponseWriter, r *http.Request) {
	var in struct{ Code, Name, Kind string }
	json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in)
	a.mu.Lock()
	exp, ok := a.pairs[in.Code]
	if ok {
		delete(a.pairs, in.Code)
	}
	a.mu.Unlock()
	if !ok || time.Now().After(exp) {
		http.Error(w, "This code has expired. Show a new one on the PC.", 403)
		return
	}
	if in.Kind != "iphone" {
		in.Kind = "android"
	}
	if in.Name == "" {
		in.Name = map[string]string{"iphone": "iPhone", "android": "Android phone"}[in.Kind]
	}
	p := &Phone{ID: randCode(5), Name: in.Name, Kind: in.Kind, Token: randCode(20), Paired: time.Now(), LastSeen: time.Now()}
	a.set.With(func(c *Config) bool { c.Phones = append(c.Phones, p); return true })
	remote, _ := a.ts.Status()
	writeJ(w, map[string]string{"token": p.Token, "id": p.ID, "remote": remote, "relay": relayURL, "link": a.linkURL()})
}

// touch marks a phone as just seen.
func (a *App) touch(id string) {
	a.set.With(func(c *Config) bool {
		for _, q := range c.Phones {
			if q.ID == id {
				q.LastSeen = time.Now()
			}
		}
		return true
	})
}

func (a *App) checkin(w http.ResponseWriter, r *http.Request, p *Phone, st *Store) {
	b, _ := io.ReadAll(io.LimitReader(r.Body, 8192))
	if !json.Valid(b) {
		b = nil
	}
	a.set.With(func(c *Config) bool {
		for _, q := range c.Phones {
			if q.ID == p.ID {
				q.LastSeen = time.Now()
				if b != nil {
					q.Status = b
				}
			}
		}
		return true
	})
	writeJ(w, map[string]any{"restores": len(p.Restores)})
}

// upload takes one file from a phone. Headers: X-Key (where it was on the phone), X-Name, X-Folder,
// X-Deleted-At (ms; 0 for an iPhone copy still on the phone), X-Sha256 (optional check).
func (a *App) upload(w http.ResponseWriter, r *http.Request, p *Phone, st *Store) {
	h := r.Header
	key, name := h.Get("X-Key"), h.Get("X-Name")
	if key == "" || name == "" {
		http.Error(w, "missing X-Key or X-Name", 400)
		return
	}
	at, _ := strconv.ParseInt(h.Get("X-Deleted-At"), 10, 64)
	body := bufio.NewReader(r.Body)
	name = unq(name)
	if filepath.Ext(name) == "" { // Shortcuts gives photo names without the extension
		head, _ := body.Peek(16)
		name += sniffExt(head)
	}
	it := Item{Key: key, Name: name, Folder: unq(h.Get("X-Folder")), Phone: p.ID, DeletedAt: msTime(at)}
	if p.Kind == "iphone" && at == 0 {
		it.Hidden = true
	}
	saved, err := st.Add(it, body, h.Get("X-Sha256"))
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJ(w, map[string]string{"id": saved.ID})
}

// sniffExt names a file type from its first bytes (the kinds an iPhone's Photos holds).
func sniffExt(b []byte) string {
	if len(b) >= 12 && string(b[4:8]) == "ftyp" {
		switch t := string(b[8:12]); {
		case t == "heic" || t == "heix" || t == "mif1" || t == "msf1" || t == "hevc":
			return ".heic"
		case t == "qt  ":
			return ".mov"
		default:
			return ".mp4"
		}
	}
	switch {
	case len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8:
		return ".jpg"
	case len(b) >= 4 && string(b[1:4]) == "PNG":
		return ".png"
	case len(b) >= 4 && string(b[:4]) == "GIF8":
		return ".gif"
	}
	return ""
}

// unq undoes the percent-encoding phones use to send non-ASCII names in headers.
func unq(s string) string {
	if u, err := url.PathUnescape(s); err == nil {
		return u
	}
	return s
}

func serveItem(w http.ResponseWriter, r *http.Request, st *Store, id string, attach bool) {
	it := st.Get(id)
	if st == nil || it == nil || it.Sha == "" {
		http.NotFound(w, r)
		return
	}
	f, err := st.Open(it)
	if err != nil {
		http.Error(w, "file missing from the vault", 500)
		return
	}
	defer f.Close()
	if ct := mime.TypeByExtension(filepath.Ext(it.Name)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	disp := "inline"
	if attach {
		disp = "attachment"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disp, map[string]string{"filename": it.Name}))
	http.ServeContent(w, r, "", it.DeletedAt, f)
}

func (a *App) uiFile(w http.ResponseWriter, r *http.Request) {
	if st := a.getStore(); st != nil {
		serveItem(w, r, st, r.PathValue("id"), false)
		return
	}
	http.NotFound(w, r)
}

func (a *App) saveToPC(w http.ResponseWriter, r *http.Request) {
	st := a.getStore()
	var it *Item
	if st != nil {
		it = st.Get(r.PathValue("id"))
	}
	if it == nil || it.Sha == "" {
		http.NotFound(w, r)
		return
	}
	home, _ := os.UserHomeDir()
	dl := filepath.Join(home, "Downloads")
	name := cleanName(it.Name, 0) // the phone named it, so it may not climb out of Downloads
	dst := freeName(dl, name)     // never over a file already in Downloads
	if err := copyFile(st.objPath(it.Sha), dst); err != nil {
		os.Remove(dst)
		http.Error(w, err.Error(), 500)
		return
	}
	os.Chtimes(dst, time.Now(), it.DeletedAt)
	writeJ(w, map[string]string{"path": dst})
}

func (a *App) queueRestore(w http.ResponseWriter, r *http.Request) {
	st := a.getStore()
	id := r.PathValue("id")
	it := (*Item)(nil)
	if st != nil {
		it = st.Get(id)
	}
	if it == nil || it.Sha == "" {
		http.NotFound(w, r)
		return
	}
	a.set.With(func(c *Config) bool {
		for _, p := range c.Phones {
			if p.ID == it.Phone {
				p.Restores = append(without(p.Restores, id), id)
			}
		}
		return true
	})
	writeJ(w, "ok")
}

func lanIP() string {
	ifs, _ := net.Interfaces()
	best := "127.0.0.1"
	for _, i := range ifs {
		if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := i.Addrs()
		for _, ad := range addrs {
			ip, _, _ := net.ParseCIDR(ad.String())
			if ip4 := ip.To4(); ip4 != nil && ip4.IsPrivate() {
				if strings.HasPrefix(ip4.String(), "192.168.") || best == "127.0.0.1" {
					best = ip4.String()
				}
			}
		}
	}
	return best
}
