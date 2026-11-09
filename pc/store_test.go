package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
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
	need, _, _ := st.SyncPhoneList("ip", []string{"i2", "i3"}, time.Now(), false)
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
	// A list that comes up short marks IMG_2 deleted; when it shows up again it's asked for, and goes back to hidden
	// as it arrives (a new photo by that name would be kept as one of its own).
	st.SyncPhoneList("ip", []string{"IMG_1"}, time.Now(), false)
	if len(st.Deleted()) != 1 {
		t.Fatal("IMG_2 should show as deleted")
	}
	need, _, _ := st.SyncPhoneList("ip", []string{"IMG_1", "IMG_2", "IMG_3"}, time.Now(), false)
	st.Add(Item{Key: "IMG_2", Name: "IMG_2.heic", Phone: "ip", Hidden: true}, strings.NewReader("b"), "")
	if len(st.Deleted()) != 0 || strings.Join(need, ",") != "IMG_2,IMG_3" {
		t.Fatalf("back on the phone: deleted=%d need=%v", len(st.Deleted()), need)
	}
	for in, want := range map[string]string{"\x00\x00\x00\x18ftypheic": ".heic", "\x00\x00\x00\x14ftypqt  ": ".mov", "\xff\xd8\xff\xe0": ".jpg", "\x89PNG": ".png", "hello": ""} {
		if got := sniffExt([]byte(in)); got != want {
			t.Errorf("sniffExt(%q) = %q, want %q", in, got, want)
		}
	}
}

// iPhone names come round again (IMG_0001 after IMG_9999). Through the Shortcut's own calls: every photo by a name is
// kept, a delete among them shows the one that went, exact copies count, and a list that's far too short (Shortcuts
// let see only some photos) marks nothing until the user says so.
func TestIphoneSameNames(t *testing.T) {
	a, h := testApp(t)
	a.set.With(func(c *Config) bool { c.Phones[0].Kind = "iphone"; return true })
	backup := func(names ...string) string {
		return call(h, "POST", "/api/phone/ios/backup", strings.NewReader(strings.Join(names, "\n"))).Body.String()
	}
	send := func(name, body string) {
		if w := call(h, "PUT", "/api/phone/upload", strings.NewReader(body), "X-Key", name, "X-Name", name); w.Code != 200 {
			t.Fatalf("upload %s: %d %s", name, w.Code, w.Body)
		}
	}
	deleted := func() (out []string) {
		for _, it := range a.getStore().Deleted() {
			out = append(out, it.Name+"="+it.Sha[:4])
		}
		return out
	}
	sha := func(s string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(s)))[:4] }

	// Before the fix only one IMG_1 was kept; the next run sends both, and the one already kept isn't stored twice.
	a.getStore().Add(Item{Key: "IMG_1", Name: "IMG_1", Phone: "p1", Hidden: true}, strings.NewReader("old"), "")
	if got := backup("IMG_1", "IMG_1"); got != "|IMG_1|" {
		t.Fatalf("two photos by one name, one kept: need %q", got)
	}
	send("IMG_1", "old")
	send("IMG_1", "new")
	if got := backup("IMG_1", "IMG_1"); got != "||" {
		t.Fatalf("both kept: need %q", got)
	}
	// The old one is deleted: both show for a moment, then the one still on the phone comes back as it's sent.
	if got := backup("IMG_1"); got != "|IMG_1|" || len(deleted()) != 2 {
		t.Fatalf("one of two deleted: need %q, deleted %v", got, deleted())
	}
	send("IMG_1", "new")
	if d := deleted(); len(d) != 1 || d[0] != "IMG_1="+sha("old") {
		t.Fatalf("the wrong IMG_1 shows as deleted: %v", d)
	}
	// Two exact copies under one name are two photos; one photo sent twice in a run is still one.
	backup("IMG_1", "IMG_2", "IMG_2", "IMG_3")
	send("IMG_2", "copy")
	send("IMG_2", "copy")
	send("IMG_3", "once")
	send("IMG_3", "once")
	if got := backup("IMG_1", "IMG_2", "IMG_2", "IMG_3"); got != "||" {
		t.Fatalf("exact copies: need %q", got)
	}
	// 60 more photos, then a list with only IMG_1: nothing is marked, the PC and the phone say why, and "I deleted
	// them" marks them.
	var all []string
	for i := 0; i < 60; i++ {
		all = append(all, fmt.Sprintf("P%d", i))
		send(all[i], all[i])
	}
	backup(append([]string{"IMG_1", "IMG_2", "IMG_2", "IMG_3"}, all...)...)
	n := len(deleted())
	if got := backup("IMG_1", "IMG_NEW"); got != "|IMG_NEW|" || len(deleted()) != n || a.getStore().Held("p1") != 63 {
		t.Fatalf("short list: need %q, deleted %d (was %d), held %d", got, len(deleted()), n, a.getStore().Held("p1"))
	}
	if w := strings.Join(a.warnings(), " "); !strings.Contains(w, "left out 63 photos") {
		t.Fatalf("no warning on the PC: %q", w)
	}
	var st struct{ Phones []phoneView }
	json.NewDecoder(call(h, "GET", "/api/phone/state", nil).Body).Decode(&st)
	if st.Phones[0].Held != 63 {
		t.Fatalf("phone state held = %d", st.Phones[0].Held)
	}
	if w := call(h, "POST", "/api/phone/ios/held", nil); w.Code != 200 || len(deleted()) != n+63 || a.getStore().Held("p1") != 0 {
		t.Fatalf("I deleted them: %d %s, deleted %d", w.Code, w.Body, len(deleted()))
	}
}
