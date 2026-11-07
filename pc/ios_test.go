package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The iPhone Shortcut's round trip: list, upload what's needed, photo leaves the phone, restore.
func TestIphoneShortcutFlow(t *testing.T) {
	dir := t.TempDir()
	st, _ := OpenStore(dir)
	a := &App{set: &Settings{path: filepath.Join(dir, "vault.json")}, pairs: map[string]time.Time{}, warn: map[string]time.Time{}, store: st}
	p := &Phone{ID: "ip", Kind: "iphone", Token: "tok", Name: "iPhone"}
	a.set.With(func(c *Config) bool { c.VaultDir = dir; c.Phones = []*Phone{p}; return true })
	h := a.routes()
	do := func(method, path, body string, hdr ...string) (int, string) {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		for i := 0; i+1 < len(hdr); i += 2 {
			r.Header.Set(hdr[i], hdr[i+1])
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		b, _ := io.ReadAll(w.Body)
		return w.Code, string(b)
	}
	if c, _ := do("POST", "/api/phone/ios/backup?t=tok", ""); c != 400 {
		t.Fatal("an empty list must be refused, not read as everything deleted")
	}
	if c, b := do("POST", "/api/phone/ios/backup?t=tok", "IMG_1\nIMG_2\n"); c != 200 || b != "|IMG_1|IMG_2|" {
		t.Fatalf("need: %d %q", c, b)
	}
	if c, b := do("PUT", "/api/phone/upload?t=tok", "\x00\x00\x00\x18ftypheic-photo", "X-Key", "IMG_1", "X-Name", "IMG_1"); c != 200 {
		t.Fatalf("upload: %d %s", c, b)
	}
	if len(st.Deleted()) != 0 {
		t.Fatal("a photo still on the iPhone must stay hidden")
	}
	do("POST", "/api/phone/ios/backup?t=tok", "IMG_2\n")
	d := st.Deleted()
	if len(d) != 1 || d[0].Name != "IMG_1.heic" || d[0].Kind != "photo" {
		t.Fatalf("deleted: %+v", d)
	}
	if _, b := do("GET", "/api/phone/ios/restores?t=tok", ""); b != "none" {
		t.Fatalf("restores: %q", b)
	}
	do("POST", "/api/phone/restore/"+d[0].ID+"?t=tok", "")
	if _, b := do("GET", "/api/phone/ios/restores?t=tok", ""); b != d[0].ID {
		t.Fatalf("restores after restore: %q", b)
	}
	if c, b := do("GET", "/api/phone/file/"+d[0].ID+"?t=tok", ""); c != 200 || !strings.Contains(b, "heic-photo") {
		t.Fatalf("file: %d", c)
	}
	do("POST", "/api/phone/restored/"+d[0].ID+"?t=tok", "")
	if _, b := do("GET", "/api/phone/ios/restores?t=tok", ""); b != "none" {
		t.Fatalf("restores after restored: %q", b)
	}
	if c, _ := do("GET", "/pair/abc", ""); c != http.StatusOK {
		t.Fatal("pair page")
	}
}
