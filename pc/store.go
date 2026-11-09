package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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
	// iPhone, kept in memory: how many photos have each name in each phone's last list, the copies sent since then,
	// and a list held back for looking too short (SyncPhoneList), under its own lock so the screens never wait on mu.
	want map[string]map[string]int
	sent map[string]map[string]bool
	hmu  sync.Mutex
	held map[string]heldList
}

// heldList is an iPhone list SyncPhoneList didn't act on, and how many photos it would have marked as deleted.
type heldList struct {
	keys []string
	n    int
}

// OpenStore opens the vault in dir, or starts a new one there. A list of files that can't be read is never taken
// for an empty vault (the next save would write over it): the copy from the save before stands in, else it fails.
func OpenStore(dir string) (*Store, error) {
	s := &Store{dir: dir, want: map[string]map[string]int{}, sent: map[string]map[string]bool{}, held: map[string]heldList{}}
	if err := os.MkdirAll(filepath.Join(dir, "objects"), 0o755); err != nil {
		return nil, err
	}
	var bad error
	for _, name := range []string{"index.json", "index.json.bak"} {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err == nil {
			if err = json.Unmarshal(b, &s.items); err == nil {
				return s, nil
			}
			s.items = nil
		}
		if bad == nil && !errors.Is(err, os.ErrNotExist) {
			bad = err
		}
	}
	if bad != nil {
		return nil, fmt.Errorf("its list of files can't be read (%v)", bad)
	}
	return s, nil
}

func (s *Store) saveLocked() error {
	p := filepath.Join(s.dir, "index.json")
	os.Rename(p, p+".bak") // the copy OpenStore falls back on
	return writeJSON(p, s.items)
}

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", " ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, err = f.Write(b)
	if err == nil {
		err = f.Sync() // on disk before the rename, so a power cut can't leave an empty file in its place
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
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
	// Locked from here: Clear and Dismiss must not delete this object before its item is listed.
	s.mu.Lock()
	defer s.mu.Unlock()
	dst := s.objPath(sha)
	if _, err := os.Stat(dst); errors.Is(err, os.ErrNotExist) {
		os.MkdirAll(filepath.Dir(dst), 0o755)
		if err := os.Rename(f.Name(), dst); err != nil {
			return nil, err
		}
	}
	if it.Hidden {
		if old, back := s.againLocked(it.Phone, it.Key, sha); old != nil {
			if back {
				return old, s.saveLocked()
			}
			return old, nil
		}
	} else if old := s.findLocked(it.Phone, it.Key); old != nil {
		return old, nil
	}
	it.ID, it.Sha, it.Size = newID(), sha, n
	if it.Kind == "" {
		it.Kind = kindOf(it.Name)
	}
	if it.Hidden {
		s.sent[it.Phone][it.ID] = true
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

// againLocked tells, for an iPhone upload, which copy the PC already keeps it is: the same content under the same name
// is that photo sent again (back on the phone, if it showed as deleted), unless that copy came in since the last list
// and the list has more photos by this name than the PC keeps: then it's an exact copy on the phone, a photo of its own.
// nil means a new photo. iPhone names come round again (IMG_0001 after IMG_9999), so a name alone can't say.
func (s *Store) againLocked(phone, key, sha string) (old *Item, back bool) {
	if s.sent[phone] == nil {
		s.sent[phone] = map[string]bool{}
	}
	sent, kept := s.sent[phone], 0
	for _, it := range s.items {
		if it.Phone != phone || it.Key != key || it.Missed || it.Dismissed {
			continue
		}
		if it.Hidden {
			kept++
		}
		if it.Sha != sha {
			continue
		}
		if old == nil {
			old = it
		}
		if !sent[it.ID] {
			sent[it.ID] = true
			if back = !it.Hidden && it.ByTime; back {
				it.Hidden, it.ByTime, it.DeletedAt = true, false, time.Time{}
			}
			return it, back
		}
	}
	if old != nil && kept < s.want[phone][key] {
		return nil, false
	}
	return old, false
}

// SyncPhoneList is for the iPhone: its Shortcut lists every photo's name, once for each photo that has it, and gets
// back the names the PC wants sent. A hidden copy whose name the phone has fewer of than the PC keeps becomes a
// deleted file; when it can't tell which of several went, all of them do and the name is asked for again, so the
// ones still on the phone come back as they arrive (againLocked). Only call it with a complete list.
// A drop too big to be real (Shortcuts was let see only some photos) marks nothing unless sure; held says how many
// it would have marked, and Confirm marks them once the user says they did delete them.
func (s *Store) SyncPhoneList(phone string, keys []string, now time.Time, sure bool) (need []string, held int, err error) {
	want := make(map[string]int, len(keys))
	for _, k := range keys {
		want[k]++
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	kept, total, gone := map[string][]*Item{}, 0, 0
	for _, it := range s.items {
		if it.Phone == phone && it.Hidden {
			kept[it.Key] = append(kept[it.Key], it)
			total++
		}
	}
	for k, hs := range kept {
		gone += max(len(hs)-want[k], 0)
	}
	// ponytail: "more than half, and over 50" is a guess at a drop nobody makes by hand; tune it if real ones trip it.
	if !sure && gone > 50 && gone*2 > total {
		held = gone
	}
	s.hmu.Lock()
	if held > 0 {
		s.held[phone] = heldList{keys, held}
	} else {
		delete(s.held, phone)
	}
	s.hmu.Unlock()
	if held == 0 && gone > 0 {
		for k, hs := range kept {
			if want[k] < len(hs) {
				for _, it := range hs {
					it.Hidden, it.ByTime, it.DeletedAt = false, true, now
				}
				delete(kept, k)
			}
		}
		err = s.saveLocked()
	}
	s.want[phone], s.sent[phone] = want, map[string]bool{}
	asked := map[string]bool{}
	for _, k := range keys {
		if want[k] > len(kept[k]) && !asked[k] {
			need, asked[k] = append(need, k), true
		}
	}
	return need, held, err
}

// Held is how many photos the iPhone's last list left out without them showing as deleted (SyncPhoneList).
func (s *Store) Held(phone string) int {
	s.hmu.Lock()
	defer s.hmu.Unlock()
	return s.held[phone].n
}

// Confirm marks the photos a held list left out as deleted: the user says they did delete them.
func (s *Store) Confirm(phone string, now time.Time) error {
	s.hmu.Lock()
	h, ok := s.held[phone]
	s.hmu.Unlock()
	if !ok {
		return errors.New("Back up again first, then try this.")
	}
	_, _, err := s.SyncPhoneList(phone, h.keys, now, true)
	return err
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
		if !it.Hidden && !it.Dismissed && it.DeletedAt.Before(cutoff) {
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
		if !it.Hidden && !it.Missed && !it.Dismissed {
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
