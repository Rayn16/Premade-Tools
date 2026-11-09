package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// testApp is the PC program with a vault in a temp folder and one paired phone (key "tok"), plus its routes.
func testApp(t *testing.T) (*App, http.Handler) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	os.MkdirAll(appDir(), 0o755) // main makes it at start
	dir := t.TempDir()
	st, _ := OpenStore(dir)
	a := &App{set: &Settings{path: filepath.Join(dir, "vault.json")}, pairs: map[string]time.Time{}, warn: map[string]time.Time{}, store: st}
	a.set.With(func(c *Config) bool {
		c.VaultDir = dir
		c.Phones = []*Phone{{ID: "p1", Kind: "android", Token: "tok", Name: "S23"}}
		return true
	})
	return a, a.routes()
}

// call sends one request: paths under /api/ui/ come from the PC's own window, the rest from the paired phone.
func call(h http.Handler, method, path string, body io.Reader, hdr ...string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, body)
	if strings.HasPrefix(path, "/api/ui/") {
		r.RemoteAddr, r.Host = "127.0.0.1:5000", "127.0.0.1:47110"
		r.Header.Set("X-Vault", "1")
	} else {
		r.Header.Set("Authorization", "Bearer tok")
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		r.Header.Set(hdr[i], hdr[i+1])
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// A name a phone sends can't climb out of Downloads when Save to PC copies the file there.
func TestSaveToPCStaysInDownloads(t *testing.T) {
	_, h := testApp(t)
	dl := filepath.Join(os.Getenv("HOME"), "Downloads")
	os.MkdirAll(dl, 0o755)
	w := call(h, "PUT", "/api/phone/upload", strings.NewReader("data"), "X-Key", "k1", "X-Name", "..%2F..%2Fescaped.txt")
	var up struct{ ID string }
	if json.NewDecoder(w.Body).Decode(&up); up.ID == "" {
		t.Fatalf("upload: %d", w.Code)
	}
	w = call(h, "POST", "/api/ui/save/"+up.ID, nil)
	var out struct{ Path string }
	json.NewDecoder(w.Body).Decode(&out)
	if filepath.Dir(out.Path) != dl {
		t.Fatalf("saved to %q, want a file in %q", out.Path, dl)
	}
}

// Names Windows can't keep as files: its reserved device names (CON, NUL, COM1…, with or without an extension)
// open a device instead, and <>:"/\|?* aren't allowed.
func TestCleanNameWindows(t *testing.T) {
	for in, want := range map[string]string{
		"CON.jpg": "_CON.jpg", "nul": "_nul", "Aux.mp3": "_Aux.mp3", "com1.txt": "_com1.txt", "LPT9 .pdf": "_LPT9 .pdf",
		"Contract.pdf": "Contract.pdf", "console.log": "console.log", "a:b.txt": "a_b.txt", "COM10.txt": "COM10.txt",
	} {
		if got := cleanName(in, 0); got != want {
			t.Errorf("cleanName(%q) = %q, want %q", in, got, want)
		}
	}
}

// fakeRelay stands in for the Friends relay: files waiting for this PC, and sends from it.
type fakeRelay struct {
	*httptest.Server
	sent chan string // names of finished sends
}

func newFakeRelay(t *testing.T) *fakeRelay {
	fr := &fakeRelay{sent: make(chan string, 10)}
	names := map[string]string{}
	fr.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch p := r.URL.Path; {
		case r.Method == "GET" && strings.HasPrefix(p, "/file/"):
			io.WriteString(w, "hello")
		case r.Method == "POST" && p == "/send":
			var in struct{ Name string }
			json.NewDecoder(r.Body).Decode(&in)
			id := newID()
			names[id] = in.Name
			writeJ(w, map[string]any{"id": id, "part": 1 << 20})
		case r.Method == "PUT" && strings.HasPrefix(p, "/send/"):
			if r.ContentLength < 0 { // the relay holds each part to its share of the size, so it needs the length
				http.Error(w, `{"error":"That part is bigger than the file."}`, 400)
				return
			}
			io.Copy(io.Discard, r.Body)
			writeJ(w, map[string]any{"n": 1, "etag": "e"})
		case strings.HasSuffix(p, "/done"):
			fr.sent <- names[strings.Split(p, "/")[2]]
			writeJ(w, "ok")
		default:
			writeJ(w, "ok")
		}
	}))
	old := relayURL
	relayURL = fr.URL
	t.Cleanup(func() { relayURL = old; fr.Close() })
	return fr
}

// What friends send arrives whatever they named it, and lands under a name Windows can keep.
func TestFriendFileNames(t *testing.T) {
	a, h := testApp(t)
	pc := t.TempDir()
	a.drops = NewDrops(func() string { return pc })
	relay := newFakeRelay(t)
	a.fr = &Friends{a: a, hc: relay.Client(), busy: map[string]bool{}, wake: make(chan struct{}, 1)}
	for _, name := range []string{"..", "a:b.txt", "CON", `..\x.txt`} {
		if err := a.fr.receive(frItem{ID: newID(), Dev: "pc", Name: name, From: "f1", FromName: "Sam"}); err != nil {
			t.Errorf("receiving %q: %v", name, err)
		}
	}
	ents, _ := os.ReadDir(pc)
	for _, e := range ents {
		if b, _ := os.ReadFile(filepath.Join(pc, e.Name())); string(b) != "hello" || cleanName(e.Name(), 0) != e.Name() {
			t.Errorf("landed as %q holding %q", e.Name(), b)
		}
	}
	if len(ents) != 4 {
		t.Errorf("%d of 4 files landed", len(ents))
	}

	// Sending a file the page picked, named "..", to a friend.
	a.fr.last = &frPeople{Approved: true, People: []frPerson{{ID: "f1", Name: "Sam"}}}
	if w := call(h, "POST", "/api/ui/friends/upload?to=f1&dev=all&name=..", strings.NewReader("hi")); w.Code != 200 {
		t.Fatalf("send: %d %s", w.Code, w.Body)
	}
	select {
	case n := <-relay.sent:
		if n == ".." || n == "" {
			t.Fatalf("the friend would get a file named %q", n)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the send never finished")
	}
}

// Notifications put names and titles from outside (a video's title, a phone's name) into a PowerShell script.
// PowerShell ends a '...' string at a curly quote too (‘ ’ ‚ ‛), so "Rayan’s video" broke the notification,
// and a title could close the string and run its own commands.
func TestPsQuote(t *testing.T) {
	for _, s := range []string{"Rayan’s video", "it's", "‘quoted’", "a‚b‛c", "’’", ""} {
		lit := psQuote(s)
		if got, rest, ok := psRead(lit); !ok || got != s || rest != "" {
			t.Errorf("psQuote(%q) = %s, which PowerShell reads as %q followed by %q", s, lit, got, rest)
		}
	}
}

// psRead reads a single-quoted string as PowerShell's tokenizer does: any of its five single quote marks ends it,
// unless the next character is one too, and then the pair is one quote mark.
func psRead(lit string) (val, rest string, ok bool) {
	isQ := func(c rune) bool { return strings.ContainsRune("'‘’‚‛", c) }
	r := []rune(lit)
	if len(r) == 0 || !isQ(r[0]) {
		return "", lit, false
	}
	var b strings.Builder
	for i := 1; i < len(r); i++ {
		if isQ(r[i]) {
			if i+1 >= len(r) || !isQ(r[i+1]) {
				return b.String(), string(r[i+1:]), true
			}
			i++
		}
		b.WriteRune(r[i])
	}
	return b.String(), "", false
}

// An empty file sent to a friend still goes: the relay takes a part only with its length up front, even 0.
func TestFriendSendEmptyFile(t *testing.T) {
	a, h := testApp(t)
	relay := newFakeRelay(t)
	a.fr = &Friends{a: a, hc: relay.Client(), busy: map[string]bool{}, wake: make(chan struct{}, 1)}
	a.fr.last = &frPeople{Approved: true, People: []frPerson{{ID: "f1", Name: "Sam"}}}
	if w := call(h, "POST", "/api/ui/friends/upload?to=f1&dev=all&name=empty.txt", strings.NewReader("")); w.Code != 200 {
		t.Fatalf("send: %d %s", w.Code, w.Body)
	}
	for end := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		a.fr.mu.Lock()
		s := *a.fr.sends[0]
		a.fr.mu.Unlock()
		if s.State == "done" {
			break
		}
		if s.State == "failed" || time.Now().After(end) {
			t.Fatalf("the send is %s: %s", s.State, s.Note)
		}
	}
}

// A song called "...Baby One More Time" is inside the folder like any other file: the app can open it,
// share it and send it on. A name that climbs out of the folder still can't.
func TestPathOfThreeDotsTitle(t *testing.T) {
	out := t.TempDir()
	d := &Downloader{dir: func() string { return out }}
	c := &Converter{dir: func() string { return out }}
	for name, inside := range map[string]bool{"...Baby One More Time.mp3": true, "Playlist/...And Justice for All.mp3": true, "../x.mp3": false} {
		if _, ok := d.Path(&Job{Files: []DLFile{{Name: name}}}, 0); ok != inside {
			t.Errorf("Downloader: %q inside = %v", name, ok)
		}
		if _, ok := c.Path(&CvJob{Files: []DLFile{{Name: name}}}, 0); ok != inside {
			t.Errorf("Converter: %q inside = %v", name, ok)
		}
	}
}

// When GitHub won't say which version is newest (too many asks this hour, say), Update says it couldn't check
// instead of "You have the newest version."
func TestUpdateWhenGitHubRefuses(t *testing.T) {
	_, h := testApp(t)
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"message":"API rate limit exceeded"}`, 403)
	}))
	defer gh.Close()
	old := releasesAPI
	releasesAPI = gh.URL
	defer func() { releasesAPI = old }()
	var out struct{ Msg string }
	json.NewDecoder(call(h, "POST", "/api/ui/update", nil).Body).Decode(&out)
	if !strings.HasPrefix(out.Msg, "Update failed") {
		t.Fatalf("Update said %q", out.Msg)
	}
}
