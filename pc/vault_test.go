package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
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
