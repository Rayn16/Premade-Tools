package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Item is one deleted file (or, for the iPhone, a hidden copy of a file still on the phone).
type Item struct {
	ID        string    `json:"id"`
	Sha       string    `json:"sha,omitempty"`
	Key       string    `json:"key"` // where it came from on the phone; same key = same file, never stored twice
	Name      string    `json:"name"`
	Folder    string    `json:"folder"`
	Phone     string    `json:"phone"`
	Kind      string    `json:"kind"` // photo, video, voice, file
	Size      int64     `json:"size"`
	DeletedAt time.Time `json:"deletedAt"`
	ByTime    bool      `json:"byTime,omitempty"` // iPhone: the PC only learns of a delete at the next backup
	Hidden    bool      `json:"hidden,omitempty"` // iPhone copy of a file still on the phone
	Missed    bool      `json:"missed,omitempty"` // deleted without the bin: couldn't be saved
	Note      string    `json:"note,omitempty"`   // why it was missed
	Dismissed bool      `json:"dismissed,omitempty"`
}

// Store keeps the index in <vault>/index.json and file contents once each in <vault>/objects/ab/<sha256>.
// ponytail: whole index in memory and rewritten on change; fine to ~100k items, move to SQLite past that.
type Store struct {
	mu    sync.Mutex
	dir   string
	items []*Item
}

func OpenStore(dir string) (*Store, error) {
	s := &Store{dir: dir}
	if err := os.MkdirAll(filepath.Join(dir, "objects"), 0o755); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(filepath.Join(dir, "index.json"))
	if err == nil {
		err = json.Unmarshal(b, &s.items)
	} else if errors.Is(err, os.ErrNotExist) {
		err = nil
	}
	return s, err
}

func (s *Store) saveLocked() error { return writeJSON(filepath.Join(s.dir, "index.json"), s.items) }

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", " ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s *Store) objPath(sha string) string { return filepath.Join(s.dir, "objects", sha[:2], sha) }

func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// Has reports whether a file with this key is already in the vault.
func (s *Store) Has(phone, key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.findLocked(phone, key) != nil
}

func (s *Store) findLocked(phone, key string) *Item {
	for _, it := range s.items {
		if it.Phone == phone && it.Key == key && !it.Missed {
			return it
		}
	}
	return nil
}

// Add streams a file into the vault. wantSha, when given, must match what arrived.
func (s *Store) Add(it Item, body io.Reader, wantSha string) (*Item, error) {
	tmpDir := filepath.Join(s.dir, "tmp")
	os.MkdirAll(tmpDir, 0o755)
	f, err := os.CreateTemp(tmpDir, "up-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(f.Name())
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, err
	}
	sha := hex.EncodeToString(h.Sum(nil))
	if wantSha != "" && !strings.EqualFold(wantSha, sha) {
		return nil, errors.New("file changed on the way: hash differs")
	}
	dst := s.objPath(sha)
	if _, err := os.Stat(dst); errors.Is(err, os.ErrNotExist) {
		os.MkdirAll(filepath.Dir(dst), 0o755)
		if err := os.Rename(f.Name(), dst); err != nil {
			return nil, err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if old := s.findLocked(it.Phone, it.Key); old != nil {
		return old, nil
	}
	it.ID, it.Sha, it.Size = newID(), sha, n
	if it.Kind == "" {
		it.Kind = kindOf(it.Name)
	}
	s.items = append(s.items, &it)
	return &it, s.saveLocked()
}

// AddMissed records a file that was deleted without passing the bin.
func (s *Store) AddMissed(it Item) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	it.ID, it.Missed = newID(), true
	if it.Kind == "" {
		it.Kind = kindOf(it.Name)
	}
	s.items = append(s.items, &it)
	return s.saveLocked()
}

// SyncPhoneList is for the iPhone: every hidden copy whose key is no longer on the phone becomes a deleted file.
// Only call it with a complete list, or files would show as deleted after a cut-short run.
func (s *Store) SyncPhoneList(phone string, keys []string, now time.Time) (need []string, err error) {
	on := make(map[string]bool, len(keys))
	for _, k := range keys {
		on[k] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	have := map[string]bool{}
	changed := false
	for _, it := range s.items {
		if it.Phone != phone || it.Missed {
			continue
		}
		have[it.Key] = true
		if it.Hidden && !on[it.Key] {
			it.Hidden, it.ByTime, it.DeletedAt, changed = false, true, now, true
		} else if !it.Hidden && it.ByTime && !it.Dismissed && on[it.Key] {
			it.Hidden, it.ByTime, it.DeletedAt, changed = true, false, time.Time{}, true // back on the phone (a list that came up short)
		}
	}
	for _, k := range keys {
		if !have[k] {
			need = append(need, k)
		}
	}
	if changed {
		err = s.saveLocked()
	}
	return need, err
}

func (s *Store) Get(id string) *Item {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, it := range s.items {
		if it.ID == id {
			c := *it
			return &c
		}
	}
	return nil
}

func (s *Store) Open(it *Item) (*os.File, error) { return os.Open(s.objPath(it.Sha)) }

// Deleted lists what the Deleted screen shows, newest first.
func (s *Store) Deleted() []Item {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Item{}
	for _, it := range s.items {
		if !it.Hidden && !it.Dismissed {
			out = append(out, *it)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DeletedAt.After(out[j].DeletedAt) })
	return out
}

// Dismiss deletes the stored copy. The entry stays (without content) so the phone
// doesn't send the same file again while it's still in its bin; Clear drops it later.
func (s *Store) Dismiss(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var sha string
	for _, it := range s.items {
		if it.ID == id && !it.Hidden {
			it.Dismissed, sha, it.Sha = true, it.Sha, ""
		}
	}
	if err := s.saveLocked(); err != nil || sha == "" {
		return err
	}
	for _, it := range s.items {
		if it.Sha == sha {
			return nil // another entry still points to the same content
		}
	}
	return os.Remove(s.objPath(sha))
}

// Expired lists deleted files older than the cutoff. Hidden iPhone copies (still on the phone) never expire.
func (s *Store) Expired(cutoff time.Time) (n int, bytes int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, it := range s.items {
		if !it.Hidden && it.DeletedAt.Before(cutoff) {
			n++
			bytes += it.Size
		}
	}
	return
}

// Clear removes deleted files older than the cutoff, then any stored content nothing points to.
func (s *Store) Clear(cutoff time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	keep := s.items[:0]
	for _, it := range s.items {
		if it.Hidden || !it.DeletedAt.Before(cutoff) {
			keep = append(keep, it)
		}
	}
	if len(keep) == len(s.items) {
		return nil
	}
	s.items = keep
	if err := s.saveLocked(); err != nil {
		return err
	}
	used := map[string]bool{}
	for _, it := range s.items {
		used[it.Sha] = true
	}
	return filepath.Walk(filepath.Join(s.dir, "objects"), func(p string, fi os.FileInfo, err error) error {
		if err == nil && !fi.IsDir() && !used[fi.Name()] {
			os.Remove(p)
		}
		return nil
	})
}

func (s *Store) Stats() (count int, bytes int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, it := range s.items {
		if !it.Hidden && !it.Missed {
			count++
			bytes += it.Size
		}
	}
	return
}

func kindOf(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif", ".dng", ".bmp", ".avif", ".jxl":
		return "photo"
	case ".mp4", ".mov", ".mkv", ".3gp", ".webm", ".avi", ".m4v":
		return "video"
	case ".m4a", ".mp3", ".aac", ".wav", ".ogg", ".amr", ".opus", ".flac", ".3ga":
		return "voice"
	}
	return "file"
}
