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
