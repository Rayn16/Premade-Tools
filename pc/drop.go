package main

// File drop: files, links and copied text between this PC and the paired phones, and from phone to phone
// through the PC. A drop for the PC lands in Downloads\Premade\Drop (text goes onto the clipboard too); a drop
// for a phone waits in appDir()\drop\<id> until that phone picks it up. Drops leave the list after 7 days.
// The clipboard is one shared slot: whatever was copied last, on the PC or a phone, is what the others get.

import (
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const dropKeep = 7 * 24 * time.Hour

type DropFile struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Kind string `json:"kind"` // photo, video, audio or file: where the S23 saves it
}

type Drop struct {
	ID      string     `json:"id"`
	At      time.Time  `json:"at"`
	From    string     `json:"from"` // "pc" or a phone id
	To      string     `json:"to"`
	Kind    string     `json:"kind"` // files, text or link
	Text    string     `json:"text,omitempty"`
	Files   []DropFile `json:"files"`
	Dir     string     `json:"-"`
	Fetched bool       `json:"fetched"` // the phone it went to has saved it
	Seen    bool       `json:"seen"`    // the phone it went to has shown a notification for it
	State   string     `json:"state"`   // always "done": lets the Android app's save code treat drops like jobs
}

type Clip struct {
	Text string    `json:"text"`
	From string    `json:"from"`
	At   time.Time `json:"at"`
}

type Drops struct {
	mu    sync.Mutex
	path  string // index.json
	hold  string // where drops for phones wait
	pcDir func() string
	items []*Drop
	clip  Clip
}

func NewDrops(pcDir func() string) *Drops {
	d := &Drops{path: filepath.Join(appDir(), "drop", "index.json"), hold: filepath.Join(appDir(), "drop"), pcDir: pcDir}
	if b, err := os.ReadFile(d.path); err == nil {
		var s struct {
			Items []*Drop
			Clip  Clip
		}
		if json.Unmarshal(b, &s) == nil {
			d.items, d.clip = s.Items, s.Clip
		}
	}
	for _, it := range d.items {
		it.Dir = d.dirOf(it)
	}
	return d
}

func (d *Drops) dirOf(it *Drop) string {
	if it.To == "pc" {
		return d.pcDir()
	}
	return filepath.Join(d.hold, it.ID)
}

func (d *Drops) saveLocked() {
	os.MkdirAll(d.hold, 0o755)
	if err := writeJSON(d.path, map[string]any{"Items": d.items, "Clip": d.clip}); err != nil {
		log.Printf("drop: %v", err)
	}
}

// Add makes a drop from text and/or files already saved in tmp (which it empties). Text that is a single web
// address becomes a link.
func (d *Drops) Add(from, to, text string, tmp string, names []string) (*Drop, error) {
	text = strings.TrimSpace(text)
	it := &Drop{ID: newID(), At: time.Now(), From: from, To: to, Kind: "files", Files: []DropFile{}, State: "done"}
	if len(names) == 0 {
		if text == "" {
			return nil, fmt.Errorf("Nothing to send. Pick files or type something.")
		}
		it.Kind, it.Text = "text", text
		if isLink(text) {
			it.Kind = "link"
		}
	}
	it.Dir = d.dirOf(it)
	if err := os.MkdirAll(it.Dir, 0o755); err != nil {
		return nil, err
	}
	for _, n := range names {
		src := filepath.Join(tmp, n)
		dst := filepath.Join(it.Dir, n)
		if to == "pc" {
			dst = freeDropName(it.Dir, n)
		}
		if os.Rename(src, dst) != nil {
			if err := copyFile(src, dst); err != nil {
				return nil, err
			}
		}
		fi, _ := os.Stat(dst)
		var sz int64
		if fi != nil {
			sz = fi.Size()
		}
		it.Files = append(it.Files, DropFile{Name: filepath.Base(dst), Size: sz, Kind: fileKind(dst)})
	}
	if tmp != "" && tmp != it.Dir {
		os.RemoveAll(tmp)
	}
	d.mu.Lock()
	d.items = append(d.items, it)
	d.saveLocked()
	d.mu.Unlock()
	return it, nil
}

// freeDropName never overwrites a file already in the PC's Drop folder: "a.jpg", then "a (2).jpg", …
func freeDropName(dir, name string) string {
	ext := filepath.Ext(name)
	p := filepath.Join(dir, name)
	for n := 2; ; n++ {
		if _, err := os.Stat(p); os.IsNotExist(err) {
			return p
		}
		p = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", strings.TrimSuffix(name, ext), n, ext))
	}
}

func isLink(s string) bool {
	if strings.ContainsAny(s, " \n\t") {
		return false
	}
	u, err := url.Parse(s)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// List is every drop, newest first; with who set, only the ones to or from that device.
func (d *Drops) List(who string) []Drop {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := []Drop{}
	for _, it := range d.items {
		if who == "" || it.From == who || it.To == who {
			out = append(out, *it)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At.After(out[j].At) })
	return out
}

func (d *Drops) Get(id string) *Drop {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, it := range d.items {
		if it.ID == id {
			c := *it
			return &c
		}
	}
	return nil
}

func (d *Drops) update(id string, f func(it *Drop)) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, it := range d.items {
		if it.ID == id {
			f(it)
			d.saveLocked()
		}
	}
}

// Path is file n of a drop on disk.
func (d *Drops) Path(it *Drop, n int) (string, bool) {
	if n < 0 || n >= len(it.Files) {
		return "", false
	}
	p := filepath.Join(it.Dir, it.Files[n].Name)
	_, err := os.Stat(p)
	return p, err == nil
}

// Remove takes a drop off the list. Files waiting for a phone go with it; files saved on the PC stay.
func (d *Drops) Remove(id string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for i, it := range d.items {
		if it.ID == id {
			if it.To != "pc" {
				os.RemoveAll(filepath.Join(d.hold, it.ID))
			}
			d.items = append(d.items[:i], d.items[i+1:]...)
			d.saveLocked()
			return
		}
	}
}

// Clear removes drops older than 7 days.
func (d *Drops) Clear(now time.Time) {
	var old []string
	d.mu.Lock()
	for _, it := range d.items {
		if now.Sub(it.At) > dropKeep {
			old = append(old, it.ID)
		}
	}
	d.mu.Unlock()
	for _, id := range old {
		d.Remove(id)
	}
}

func (d *Drops) Clip() Clip {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.clip
}

// SetClip records a new copy. False when it's the same text already there (nothing to pass on).
func (d *Drops) SetClip(from, text string) bool {
	if strings.TrimSpace(text) == "" || len(text) > 256<<10 {
		return false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.clip.Text == text {
		return false
	}
	d.clip = Clip{Text: text, From: from, At: time.Now()}
	d.saveLocked()
	return true
}

// ---------- the PC's side ----------

type dropDevice struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"` // pc, android or iphone
}

// dropDevices is everywhere a drop can go: this PC and each paired phone.
func (a *App) dropDevices() []dropDevice {
	out := []dropDevice{{"pc", "PC", "pc"}}
	for _, p := range a.set.Get().Phones {
		out = append(out, dropDevice{p.ID, p.Name, p.Kind})
	}
	return out
}

func (a *App) devName(id string) string {
	for _, d := range a.dropDevices() {
		if d.ID == id {
			return d.Name
		}
	}
	return strings.TrimPrefix(id, "friend:")
}

// dropArrived tells the device a drop is for: the PC puts text on the clipboard and shows a notification; a phone
// with notifications on gets a pop-up (the S23 app also checks for itself).
func (a *App) dropArrived(it *Drop) {
	from := a.devName(it.From)
	if it.To != "pc" {
		what := map[string]string{"text": "text", "link": "a link", "files": "you something"}[it.Kind]
		a.pushTo(it.To, from+" sent "+what, dropNote(it))
		return
	}
	switch it.Kind {
	case "text":
		if a.set.Get().ClipSync {
			a.putClip(it.From, it.Text)
		} else {
			clipSet(it.Text)
		}
		say("File drop", from+" sent text. It's on the clipboard.", "drop")
	case "link":
		say("File drop", from+" sent a link: "+it.Text, "drop")
	default:
		say("File drop", fmt.Sprintf("%s sent %d %s. It's in %s.", from, len(it.Files), plural(len(it.Files), "file", "files"), it.Dir), "drop")
	}
}

// putClip puts a phone's copy onto the PC's clipboard (without the watcher sending it straight back).
func (a *App) putClip(from, text string) {
	if !a.drops.SetClip(from, text) || !a.set.Get().ClipSync {
		return
	}
	a.mu.Lock()
	clipSet(text)
	a.clipSeq = clipSeqNow()
	a.mu.Unlock()
}

// watchClip passes on what's copied on the PC. It looks at Windows' clipboard counter each second, which is cheap.
func (a *App) watchClip() {
	a.mu.Lock()
	a.clipSeq = clipSeqNow()
	a.mu.Unlock()
	for range time.Tick(time.Second) {
		s := clipSeqNow()
		a.mu.Lock()
		changed := s != a.clipSeq
		a.clipSeq = s
		a.mu.Unlock()
		if !changed || !a.set.Get().ClipSync {
			continue
		}
		if t, ok := clipGet(); ok {
			a.drops.SetClip("pc", t)
		}
	}
}
