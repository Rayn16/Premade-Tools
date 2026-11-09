package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// A file arriving while the hourly clean-up runs must never lose its only copy.
func TestAddDuringClearKeepsFile(t *testing.T) {
	st, _ := OpenStore(t.TempDir())
	old := time.Now().Add(-400 * 24 * time.Hour)
	for i := 0; i < 300; i++ {
		st.Add(Item{Key: fmt.Sprint("old", i), Name: "o.jpg", Phone: "p", DeletedAt: old}, strings.NewReader(fmt.Sprint("old", i)), "")
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); st.Clear(time.Now().Add(-365 * 24 * time.Hour)) }()
		go func() {
			defer wg.Done()
			st.Add(Item{Key: fmt.Sprint("new", i), Name: "n.jpg", Phone: "p", DeletedAt: time.Now()}, strings.NewReader(fmt.Sprint("new", i)), "")
		}()
		wg.Wait()
	}
	for _, it := range st.Deleted() {
		if _, err := os.Stat(st.objPath(it.Sha)); err != nil {
			t.Fatalf("%s is listed but its file is gone", it.Key)
		}
	}
}

// Same for Dismiss: dismissing one file must not delete content another file is arriving with.
func TestAddDuringDismissKeepsFile(t *testing.T) {
	st, _ := OpenStore(t.TempDir())
	for i := 0; i < 300; i++ {
		body := fmt.Sprint("same", i)
		a, _ := st.Add(Item{Key: fmt.Sprint("a", i), Name: "a.jpg", Phone: "p", DeletedAt: time.Now()}, strings.NewReader(body), "")
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); st.Dismiss(a.ID) }()
		go func() {
			defer wg.Done()
			st.Add(Item{Key: fmt.Sprint("b", i), Name: "b.jpg", Phone: "p", DeletedAt: time.Now()}, strings.NewReader(body), "")
		}()
		wg.Wait()
	}
	for _, it := range st.Deleted() {
		if _, err := os.Stat(st.objPath(it.Sha)); err != nil {
			t.Fatalf("%s is listed but its file is gone", it.Key)
		}
	}
}

// Opening, saving or restoring a file that was just dismissed answers "not found" instead of crashing.
func TestDismissedFileNotFound(t *testing.T) {
	st, _ := OpenStore(t.TempDir())
	it, _ := st.Add(Item{Key: "k", Name: "a.jpg", Phone: "p", DeletedAt: time.Now()}, strings.NewReader("x"), "")
	st.Dismiss(it.ID)
	w := httptest.NewRecorder()
	serveItem(w, httptest.NewRequest("GET", "/", nil), st, it.ID, false)
	if w.Code != http.StatusNotFound {
		t.Fatalf("got %d, want 404", w.Code)
	}
}

// Dismissed files are gone from the vault, so they don't count toward its size or the "will be removed" number.
func TestDismissedNotCounted(t *testing.T) {
	st, _ := OpenStore(t.TempDir())
	old := time.Now().Add(-400 * 24 * time.Hour)
	it, _ := st.Add(Item{Key: "k", Name: "a.jpg", Phone: "p", DeletedAt: old}, strings.NewReader("12345"), "")
	st.Dismiss(it.ID)
	if n, b := st.Stats(); n != 0 || b != 0 {
		t.Fatalf("stats = %d files, %d bytes; want 0, 0", n, b)
	}
	if n, b := st.Expired(time.Now()); n != 0 || b != 0 {
		t.Fatalf("expired = %d files, %d bytes; want 0, 0", n, b)
	}
}

// A damaged list of files (a power cut, a failing drive) is never taken for an empty vault: the copy from the
// save before stands in, and with no good copy the vault doesn't open, so nothing writes over it.
func TestDamagedIndexNotOverwritten(t *testing.T) {
	dir := t.TempDir()
	st, _ := OpenStore(dir)
	for i := 0; i < 3; i++ {
		st.Add(Item{Key: fmt.Sprint("k", i), Name: "a.jpg", Phone: "p", DeletedAt: time.Now()}, strings.NewReader(fmt.Sprint("data", i)), "")
	}
	idx := dir + "/index.json"
	b, _ := os.ReadFile(idx)
	os.WriteFile(idx, b[:len(b)-40], 0o644)
	st, err := OpenStore(dir)
	if err != nil || len(st.Deleted()) != 2 {
		t.Fatalf("with the copy from the save before: %v, %d files", err, len(st.Deleted()))
	}
	os.WriteFile(idx, b[:len(b)-40], 0o644)
	os.Remove(idx + ".bak")
	if st, err := OpenStore(dir); st != nil || err == nil {
		t.Fatal("a vault whose list can't be read opened as if empty")
	}
}

// The vault's drive missing at start: phones keep working (state and the list answer), the window can pick a new
// folder without crashing, and the vault opens by itself once its folder is back.
func TestVaultMissingAtStart(t *testing.T) {
	a, h := testApp(t)
	gone := filepath.Join(t.TempDir(), "not a folder")
	os.WriteFile(gone, nil, 0o644) // a file where the drive's folder should be, so the vault can't open
	a.set.With(func(c *Config) bool { c.VaultDir = filepath.Join(gone, "Premade Vault"); return true })
	a.store = nil
	a.openVault()
	if a.getStore() != nil || a.noVault == "" {
		t.Fatal("a vault folder that can't be opened opened")
	}
	var state struct{ Vault string }
	if w := call(h, "GET", "/api/phone/state", nil); w.Code != 200 || json.NewDecoder(w.Body).Decode(&state) != nil || state.Vault == "" {
		t.Fatalf("phone state with no vault: %d %+v", w.Code, state)
	}
	if w := call(h, "GET", "/api/phone/deleted", nil); w.Code != 200 || strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatalf("phone list with no vault: %d %s", w.Code, w.Body)
	}
	dir := filepath.Join(t.TempDir(), "New vault")
	if w := call(h, "POST", "/api/ui/vault", strings.NewReader(fmt.Sprintf(`{"dir":%q}`, dir))); w.Code != 200 || a.getStore() == nil {
		t.Fatalf("a new folder while the old one is missing: %d %s", w.Code, w.Body)
	}

	a.store, a.noVault = nil, ""
	a.set.With(func(c *Config) bool { c.VaultDir = dir; return true })
	a.openVault() // the 30 s retry, once the folder is back
	if a.getStore() == nil {
		t.Fatal("the vault didn't open once its folder was back")
	}
}

// While the vault moves, the store is held for the copy; the window and the phones still get their lists.
func TestMovingVaultDoesNotFreezeLists(t *testing.T) {
	a, h := testApp(t)
	call(h, "PUT", "/api/phone/upload", strings.NewReader("data"), "X-Key", "k1", "X-Name", "a.jpg")
	st := a.getStore()
	n, b := st.Stats()
	a.moving = &moveSnap{items: st.Deleted(), n: n, b: b}
	st.mu.Lock() // as moveVault does for the whole copy
	defer st.mu.Unlock()
	done := make(chan bool)
	go func() {
		call(h, "GET", "/api/ui/state", nil)
		call(h, "GET", "/api/ui/deleted", nil)
		call(h, "GET", "/api/phone/state", nil)
		call(h, "GET", "/api/phone/deleted", nil)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the lists waited for the move")
	}
}
