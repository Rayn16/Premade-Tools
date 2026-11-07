package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestStore(t *testing.T) {
	dir := t.TempDir()
	st, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-400 * 24 * time.Hour)
	a, _ := st.Add(Item{Key: "k1", Name: "a.jpg", Phone: "p", DeletedAt: old}, strings.NewReader("same"), "")
	b, _ := st.Add(Item{Key: "k2", Name: "b.jpg", Phone: "p", DeletedAt: time.Now()}, strings.NewReader("same"), "")
	again, _ := st.Add(Item{Key: "k1", Name: "a.jpg", Phone: "p"}, strings.NewReader("same"), "")
	if again.ID != a.ID || a.Sha != b.Sha || len(st.Deleted()) != 2 {
		t.Fatal("same key should not be stored twice; same content shares one object")
	}
	if _, err := st.Add(Item{Key: "k3", Name: "c", Phone: "p"}, strings.NewReader("x"), "00"); err == nil {
		t.Fatal("hash mismatch must fail")
	}
	// iPhone: hidden copies show only once they leave the phone, and only on a complete list.
	st.Add(Item{Key: "i1", Name: "IMG_1.HEIC", Phone: "ip", Hidden: true}, strings.NewReader("p1"), "")
	st.Add(Item{Key: "i2", Name: "IMG_2.HEIC", Phone: "ip", Hidden: true}, strings.NewReader("p2"), "")
	need, _ := st.SyncPhoneList("ip", []string{"i2", "i3"}, time.Now())
	if len(need) != 1 || need[0] != "i3" || len(st.Deleted()) != 3 {
		t.Fatalf("sync: need=%v deleted=%d", need, len(st.Deleted()))
	}
	// Keep 1 year: a.jpg (400 days) goes, its shared object stays for b.jpg; hidden i2 is never cleared.
	if n, _ := st.Expired(time.Now().Add(-365 * 24 * time.Hour)); n != 1 {
		t.Fatalf("expired = %d", n)
	}
	st.Clear(time.Now().Add(-365 * 24 * time.Hour))
	if st.Get(a.ID) != nil || st.Get(b.ID) == nil {
		t.Fatal("clear removed the wrong item")
	}
	if _, err := os.Stat(st.objPath(b.Sha)); err != nil {
		t.Fatal("shared object was removed")
	}
	// Dismiss deletes the stored content but remembers the key, so the phone won't send it again.
	c, _ := st.Add(Item{Key: "k4", Name: "d.jpg", Phone: "p", DeletedAt: time.Now()}, strings.NewReader("only-d"), "")
	cp := st.objPath(c.Sha)
	if err := st.Dismiss(c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(cp); !os.IsNotExist(err) || !st.Has("p", "k4") {
		t.Fatal("dismiss should delete the object and keep the key")
	}
	for _, it := range st.Deleted() {
		if it.ID == c.ID {
			t.Fatal("dismissed item still listed")
		}
	}
	st.Dismiss(b.ID) // b's object was shared with a, which is gone now, so it is deleted too
	st2, _ := OpenStore(dir)
	if len(st2.items) != len(st.items) {
		t.Fatal("index not saved")
	}
}

func TestNewer(t *testing.T) {
	if !newer("v0.1.10", "0.1.9") || newer("0.1.0", "0.1.0") || newer("v0.0.9", "0.1.0") {
		t.Fatal("version compare")
	}
}

func TestIphone(t *testing.T) {
	st, _ := OpenStore(t.TempDir())
	st.Add(Item{Key: "IMG_1", Name: "IMG_1.heic", Phone: "ip", Hidden: true}, strings.NewReader("a"), "")
	st.Add(Item{Key: "IMG_2", Name: "IMG_2.heic", Phone: "ip", Hidden: true}, strings.NewReader("b"), "")
	// A list that comes up short marks IMG_2 deleted; when it shows up again it goes back to hidden.
	st.SyncPhoneList("ip", []string{"IMG_1"}, time.Now())
	if len(st.Deleted()) != 1 {
		t.Fatal("IMG_2 should show as deleted")
	}
	need, _ := st.SyncPhoneList("ip", []string{"IMG_1", "IMG_2", "IMG_3"}, time.Now())
	if len(st.Deleted()) != 0 || len(need) != 1 || need[0] != "IMG_3" {
		t.Fatalf("back on the phone: deleted=%d need=%v", len(st.Deleted()), need)
	}
	for in, want := range map[string]string{"\x00\x00\x00\x18ftypheic": ".heic", "\x00\x00\x00\x14ftypqt  ": ".mov", "\xff\xd8\xff\xe0": ".jpg", "\x89PNG": ".png", "hello": ""} {
		if got := sniffExt([]byte(in)); got != want {
			t.Errorf("sniffExt(%q) = %q, want %q", in, got, want)
		}
	}
}
