package main

import (
	"bytes"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDrops(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	pc := t.TempDir()
	d := NewDrops(func() string { return pc })

	if it, _ := d.Add("ph1", "pc", " https://x.com/a/status/1 ", "", nil); it.Kind != "link" {
		t.Fatalf("link: %+v", it)
	}
	if it, _ := d.Add("ph1", "pc", "hello there", "", nil); it.Kind != "text" {
		t.Fatalf("text: %+v", it)
	}
	if _, err := d.Add("ph1", "pc", "  ", "", nil); err == nil {
		t.Fatal("empty drop accepted")
	}
	// Two files with one name into the PC folder: the second gets a new name, nothing is overwritten.
	for i := 0; i < 2; i++ {
		tmp := t.TempDir()
		os.WriteFile(filepath.Join(tmp, "a.jpg"), []byte{0xFF, 0xD8, byte(i)}, 0o644)
		it, err := d.Add("ph1", "pc", "", tmp, []string{"a.jpg"})
		if err != nil || it.Files[0].Kind != "photo" {
			t.Fatalf("file: %v %+v", err, it)
		}
	}
	if _, err := os.Stat(filepath.Join(pc, "a (2).jpg")); err != nil {
		t.Fatal("second a.jpg overwrote the first")
	}
	// A drop for a phone waits in the hold folder and is served from there.
	tmp := t.TempDir()
	os.WriteFile(filepath.Join(tmp, "n.pdf"), []byte("%PDF"), 0o644)
	it, _ := d.Add("pc", "ph2", "", tmp, []string{"n.pdf"})
	if p, ok := d.Path(it, 0); !ok || filepath.Dir(p) != filepath.Join(d.hold, it.ID) {
		t.Fatalf("held file at %q", p)
	}
	if n := len(d.List("ph2")); n != 1 {
		t.Fatalf("ph2 sees %d drops", n)
	}
	// It all survives a restart, and old drops clear (taking held files, keeping the PC's).
	d = NewDrops(func() string { return pc })
	if len(d.List("")) != 5 {
		t.Fatalf("after restart: %d", len(d.List("")))
	}
	d.Clear(time.Now().Add(8 * 24 * time.Hour))
	if len(d.List("")) != 0 {
		t.Fatal("old drops kept")
	}
	if _, err := os.Stat(filepath.Join(d.hold, it.ID)); !os.IsNotExist(err) {
		t.Fatal("held file kept")
	}
	if _, err := os.Stat(filepath.Join(pc, "a.jpg")); err != nil {
		t.Fatal("PC file removed")
	}
	if !d.SetClip("pc", "x") || d.SetClip("ph1", "x") {
		t.Fatal("clip repeat not ignored")
	}
}

// Two phones dropping a file with one name at the same moment (two "Note.txt"s): both land, neither overwrites
// the other.
func TestDropsSameNameAtOnce(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	pc := t.TempDir()
	d := NewDrops(func() string { return pc })
	var wg sync.WaitGroup
	for i := range 20 {
		tmp := t.TempDir()
		os.WriteFile(filepath.Join(tmp, "Note.txt"), []byte{byte(i)}, 0o644)
		wg.Add(1)
		go func() { defer wg.Done(); d.Add("ph1", "pc", "", tmp, []string{"Note.txt"}) }()
	}
	wg.Wait()
	got := map[string]bool{}
	for _, it := range d.List("") {
		b, _ := os.ReadFile(filepath.Join(pc, it.Files[0].Name))
		got[string(b)] = true
	}
	if len(got) != 20 {
		t.Fatalf("%d of 20 notes are still there", len(got))
	}
}

// Long text sent with File drop arrives whole (it was cut at 4 KB, mid-letter), and text past what a clipboard
// takes is refused with a reason instead of cut.
func TestLongDropText(t *testing.T) {
	a, h := testApp(t)
	a.drops = NewDrops(func() string { return t.TempDir() })
	send := func(text string) *httptest.ResponseRecorder {
		var b bytes.Buffer
		mw := multipart.NewWriter(&b)
		mw.WriteField("text", text)
		mw.Close()
		return call(h, "POST", "/api/phone/drop/send?to=pc", &b, "Content-Type", mw.FormDataContentType())
	}
	long := strings.Repeat("مرحبا بالعالم ", 1000)
	if w := send(long); w.Code != 200 {
		t.Fatalf("long text: %d %s", w.Code, w.Body)
	}
	if got := a.drops.List("pc"); len(got) != 1 || got[0].Text != strings.TrimSpace(long) {
		t.Fatalf("the text arrived cut: %d drops, %d of %d bytes", len(got), len(got[0].Text), len(long))
	}
	if w := send(strings.Repeat("a", 300<<10)); w.Code != 400 {
		t.Fatalf("too long: %d %s", w.Code, w.Body)
	}
	if n := dropNote(&a.drops.List("pc")[0]); len([]rune(n)) > 201 {
		t.Fatalf("a push would carry %d letters", len([]rune(n)))
	}
}
