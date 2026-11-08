package main

import (
	"os"
	"path/filepath"
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
