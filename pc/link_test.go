package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Phone calls through the relay's link to the PC, both ways, with a file big enough to need the PC to wait for acks.
// Needs a relay running here: cd relay && sh build.sh && npx wrangler dev --local, then PREMADE_RELAY=http://localhost:8787
func TestRelayLink(t *testing.T) {
	relay := os.Getenv("PREMADE_RELAY")
	if relay == "" {
		t.Skip("no relay running (set PREMADE_RELAY)")
	}
	relayURL = relay
	dir := t.TempDir()
	st, _ := OpenStore(dir)
	a := &App{set: &Settings{path: filepath.Join(dir, "vault.json")}, pairs: map[string]time.Time{}, warn: map[string]time.Time{}, store: st}
	a.set.With(func(c *Config) bool {
		c.VaultDir = dir
		c.Phones = []*Phone{{ID: "ip", Kind: "iphone", Token: "tok", Name: "iPhone"}}
		c.LinkID, c.LinkKey = randHex(16), randHex(32)
		return true
	})
	go a.linkOnce(a.routes())
	base := a.linkURL()
	do := func(method, path string, body []byte, hdr ...string) (int, []byte, http.Header) {
		r, _ := http.NewRequest(method, base+path, bytes.NewReader(body))
		if body == nil {
			r, _ = http.NewRequest(method, base+path, nil)
		}
		for i := 0; i+1 < len(hdr); i += 2 {
			r.Header.Set(hdr[i], hdr[i+1])
		}
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		return res.StatusCode, b, res.Header
	}
	for i := 0; ; i++ { // wait for the link to come up
		if c, _, _ := do("GET", "/api/phone/state", nil, "Authorization", "Bearer tok"); c == 200 {
			break
		} else if i > 50 {
			t.Fatalf("link never came up: %d", c)
		}
		time.Sleep(100 * time.Millisecond)
	}
	sum := sha256.Sum256([]byte("tok")) // the phone finds its PC by itself
	for i := 0; ; i++ {
		res, err := http.Get(relay + "/find/" + hex.EncodeToString(sum[:]))
		if err == nil && res.StatusCode == 200 {
			var f struct{ Link string }
			json.NewDecoder(res.Body).Decode(&f)
			if f.Link != base {
				t.Fatalf("found %q, want %q", f.Link, base)
			}
			break
		} else if i > 50 {
			t.Fatal("the relay never learned this PC's phones")
		}
		time.Sleep(100 * time.Millisecond)
	}
	if c, _, _ := do("GET", "/api/phone/state", nil, "Authorization", "Bearer wrong"); c != 401 && c != 403 {
		t.Fatalf("a wrong phone key got %d", c)
	}
	big := make([]byte, 5<<20)
	rand.Read(big)
	copy(big, "\x00\x00\x00\x18ftypheic")
	if c, b, _ := do("PUT", "/api/phone/upload?t=tok", big, "X-Key", "IMG_9", "X-Name", "IMG_9"); c != 200 {
		t.Fatalf("upload: %d %s", c, b)
	}
	do("POST", "/api/phone/ios/backup?t=tok", []byte("IMG_1\n"))
	d := st.Deleted()
	if len(d) != 1 {
		t.Fatalf("deleted: %+v", d)
	}
	c, b, h := do("GET", "/api/phone/file/"+d[0].ID+"?t=tok", nil)
	if c != 200 || !bytes.Equal(b, big) {
		t.Fatalf("file back: %d, %d bytes, same=%v", c, len(b), bytes.Equal(b, big))
	}
	if h.Get("Content-Length") != "5242880" {
		t.Errorf("length not passed on: %q", h.Get("Content-Length"))
	}
	if c, b, _ := do("GET", "/api/phone/file/"+d[0].ID+"?t=tok", nil, "Range", "bytes=10-19"); c != 206 || !bytes.Equal(b, big[10:20]) {
		t.Fatalf("range: %d %q", c, b)
	}
	// Someone else can't take over the PC's place on the relay.
	r, _ := http.NewRequest("GET", base+"/body/1", nil)
	r.Header.Set("Authorization", "Bearer "+randHex(32))
	if res, err := http.DefaultClient.Do(r); err != nil || res.StatusCode != 401 {
		t.Fatalf("another key wasn't refused: %v %v", res.StatusCode, err)
	}
}
