package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

// Friends: everyone who has the app, through the Cloudflare relay (relay/ in this repo). The PC is home base: it
// checks in for itself and its phones, sends for them, and hands what friends send into File drop.
var relayURL = "https://premade-friends.ral4-xxx.workers.dev"

const relayPart = 50 << 20

type frPerson struct {
	ID      string       `json:"id"`
	Name    string       `json:"name"`
	Devices []dropDevice `json:"devices"`
	Online  bool         `json:"online"`
	Seen    int64        `json:"seen"`
}

type frPeople struct {
	ID       string     `json:"id"`
	Name     string     `json:"name"`
	Approved bool       `json:"approved"`
	Admin    bool       `json:"admin"`
	Used     int64      `json:"used"`
	Cap      int64      `json:"cap"`
	Max      int64      `json:"max"`
	People   []frPerson `json:"people"`
	Waiting  []struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Asked int64  `json:"asked"`
	} `json:"waiting"`
}

// frSend is one file on its way to a friend, shown under Sending until it's done.
type frSend struct {
	ID     string    `json:"id"`
	Name   string    `json:"name"`
	To     string    `json:"to"` // the friend's name
	Dev    string    `json:"dev"`
	From   string    `json:"from"` // which of my devices asked: "pc" or a phone id
	Pct    float64   `json:"pct"`
	State  string    `json:"state"` // running, done, failed
	Note   string    `json:"note,omitempty"`
	At     time.Time `json:"at"`
	size   int64
	path   string
	remove bool // a temp copy (uploaded from a phone or the picker): delete it after
}

type Friends struct {
	a     *App
	hc    *http.Client
	mu    sync.Mutex
	last  *frPeople
	err   string
	sends []*frSend
	busy  map[string]bool // inbox ids being fetched
	wake  chan struct{}
}

func NewFriends(a *App) *Friends {
	f := &Friends{a: a, hc: &http.Client{}, busy: map[string]bool{}, wake: make(chan struct{}, 1)}
	if u := os.Getenv("PREMADE_RELAY"); u != "" { // tests and trying a relay running on this PC
		relayURL = u
	}
	go f.loop()
	return f
}

func (f *Friends) poke() {
	select {
	case f.wake <- struct{}{}:
	default:
	}
}

// call talks to the relay. body is JSON unless it's an io.Reader.
func (f *Friends) call(method, path string, body any, out any) error {
	var rd io.Reader
	isJSON := false
	if r, ok := body.(io.Reader); ok {
		rd = r
	} else if body != nil {
		b, _ := json.Marshal(body)
		rd, isJSON = bytes.NewReader(b), true
	}
	// A small call (a check-in) gets 30 s in all, so a stuck one never holds up the loop. A file takes as long as it
	// takes on a slow line, and stops only when nothing has moved for frStall.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, file := out.(io.Writer)
	file = file || rd != nil && !isJSON
	wait := 30 * time.Second
	if file {
		wait = frStall
	}
	stall := time.AfterFunc(wait, cancel)
	defer stall.Stop()
	moved := func() {
		if file {
			stall.Reset(wait)
		}
	}
	if rd != nil && !isJSON {
		rd = onRead{rd, moved}
	}
	req, err := http.NewRequestWithContext(ctx, method, relayURL+path, rd)
	if err != nil {
		return err
	}
	if isJSON {
		req.Header.Set("Content-Type", "application/json")
	}
	if sr, ok := body.(*io.SectionReader); ok { // R2 wants to know each part's length up front
		req.ContentLength = sr.Size()
		if sr.Size() == 0 { // or Go sends an empty part with no length at all
			req.Body = http.NoBody
		}
	}
	if t := f.a.set.Get().FrTok; t != "" {
		req.Header.Set("Authorization", "Bearer "+t)
	}
	res, err := f.hc.Do(req)
	if err != nil {
		return fmt.Errorf("Can't reach Friends right now. Check the internet.")
	}
	defer res.Body.Close()
	if res.StatusCode == 401 { // removed by the owner: start over
		f.a.set.With(func(c *Config) bool { c.FrTok, c.FrID = "", ""; return true })
		return fmt.Errorf("You were removed from Friends. Ask to join again.")
	}
	if res.StatusCode >= 300 {
		var e struct{ Error string }
		json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&e)
		if e.Error == "" {
			e.Error = res.Status
		}
		return fmt.Errorf("%s", e.Error)
	}
	if w, ok := out.(io.Writer); ok {
		_, err = io.Copy(w, onRead{res.Body, moved})
		return err
	}
	if out != nil {
		return json.NewDecoder(res.Body).Decode(out)
	}
	return nil
}

var frStall = 2 * time.Minute

// onRead calls f after each read: Friends uses it to see a file is still moving.
type onRead struct {
	io.Reader
	f func()
}

func (r onRead) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	r.f()
	return n, err
}

func (f *Friends) devices() []dropDevice {
	c := f.a.set.Get()
	out := f.a.dropDevices()
	if c.FrPC != "" {
		out[0].Name = c.FrPC
	}
	return out
}

func (f *Friends) Join(name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("Type your name.")
	}
	var r struct{ ID, Token string }
	if err := f.call("POST", "/join", map[string]any{"name": name, "devices": f.devices()}, &r); err != nil {
		return err
	}
	f.a.set.With(func(c *Config) bool { c.FrTok, c.FrID, c.FrName = r.Token, r.ID, name; return true })
	f.poke()
	return nil
}

// loop checks in about once a minute: my devices, everyone else, and anything waiting for me.
func (f *Friends) loop() {
	for {
		if f.a.set.Get().FrTok != "" {
			f.checkIn()
		}
		// While waiting to be approved, look every 10 seconds so the approval shows up at once.
		wait := time.Minute
		f.mu.Lock()
		if f.last == nil || !f.last.Approved {
			wait = 10 * time.Second
		}
		f.mu.Unlock()
		select {
		case <-f.wake:
		case <-time.After(wait):
		}
	}
}

func (f *Friends) checkIn() {
	if f.refresh() {
		f.fetchInbox()
	}
}

// refresh tells the relay about my devices and gets everyone else. True when I'm approved.
func (f *Friends) refresh() bool {
	c := f.a.set.Get()
	var p frPeople
	err := f.call("PUT", "/me", map[string]any{"name": c.FrName, "devices": f.devices()}, nil)
	if err == nil {
		err = f.call("GET", "/people", nil, &p)
	}
	f.mu.Lock()
	f.err = ""
	if err != nil {
		f.err = err.Error()
	} else {
		f.last = &p
	}
	f.mu.Unlock()
	return err == nil && p.Approved
}

type frItem struct {
	ID       string `json:"id"`
	Dev      string `json:"dev"`
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	From     string `json:"from"`
	FromName string `json:"fromName"`
}

// fetchInbox brings each waiting file down, puts it in File drop on the device it was meant for (or all of them),
// then deletes it from the relay.
func (f *Friends) fetchInbox() {
	var items []frItem
	if f.call("GET", "/inbox", nil, &items) != nil {
		return
	}
	for _, it := range items {
		f.mu.Lock()
		skip := f.busy[it.ID]
		f.busy[it.ID] = true
		f.mu.Unlock()
		if skip {
			continue
		}
		err := f.receive(it)
		if err != nil {
			log.Printf("friends: %s from %s: %v", it.Name, it.FromName, err)
		}
		f.mu.Lock()
		delete(f.busy, it.ID)
		f.mu.Unlock()
	}
}

func (f *Friends) receive(it frItem) error {
	tmp, err := os.MkdirTemp(appDir(), "friend-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	name := cleanName(it.Name, 0)
	out, err := os.Create(filepath.Join(tmp, name))
	if err != nil {
		return err
	}
	err = f.call("GET", "/file/"+it.ID, nil, out)
	out.Close()
	if err != nil {
		return err
	}
	// A drop one of my own phones sent while this PC was off comes as "device@phone".
	dev, fromPhone, mine := strings.Cut(it.Dev, "@")
	mine = mine && it.From == f.a.set.Get().FrID
	var to []string
	for _, d := range f.a.dropDevices() {
		if dev == "all" || dev == d.ID {
			to = append(to, d.ID)
		}
	}
	if len(to) == 0 { // that phone was unpaired since: the PC keeps it
		to = []string{"pc"}
	}
	from := "friend:" + it.FromName
	if mine {
		from = fromPhone
	}
	for i, dev := range to {
		dir := tmp
		if i < len(to)-1 { // Add moves the file, so every device but the last gets its own copy
			if dir, err = os.MkdirTemp(appDir(), "friend-"); err != nil {
				return err
			}
			if err = copyFile(filepath.Join(tmp, name), filepath.Join(dir, name)); err != nil {
				os.RemoveAll(dir)
				return err
			}
		}
		d, err := f.a.drops.Add(from, dev, "", dir, []string{name})
		if err != nil {
			return err
		}
		f.a.dropArrived(d)
	}
	return f.call("DELETE", "/file/"+it.ID, nil, nil)
}

// Send queues files for a friend's device ("all" for every one of them).
func (f *Friends) Send(from, to, dev string, paths []string, temp bool) error {
	f.mu.Lock()
	var person *frPerson
	if f.last != nil {
		for i := range f.last.People {
			if f.last.People[i].ID == to {
				person = &f.last.People[i]
			}
		}
	}
	f.mu.Unlock()
	if person == nil {
		return fmt.Errorf("That person isn't in Friends any more.")
	}
	if len(paths) == 0 {
		return fmt.Errorf("Nothing to send.")
	}
	for _, p := range paths {
		fi, err := os.Stat(p)
		if err != nil {
			return fmt.Errorf("%s is gone from the PC.", filepath.Base(p))
		}
		if fi.Size() > 1<<30 {
			return fmt.Errorf("%s is over 1 GB, the most one send can be.", filepath.Base(p))
		}
	}
	devName := "all devices"
	for _, d := range person.Devices {
		if d.ID == dev {
			devName = d.Name
		}
	}
	for _, p := range paths {
		fi, _ := os.Stat(p)
		s := &frSend{ID: newID(), Name: filepath.Base(p), To: person.Name, Dev: devName, From: from, State: "running", At: time.Now(), size: fi.Size(), path: p, remove: temp}
		f.mu.Lock()
		f.sends = append([]*frSend{s}, f.sends...)
		if len(f.sends) > 30 {
			f.sends = f.sends[:30]
		}
		f.mu.Unlock()
		go f.upload(s, to, dev)
	}
	return nil
}

var frUploads = make(chan struct{}, 2) // two at a time, so a big video doesn't hold up everything else

func (f *Friends) upload(s *frSend, to, dev string) {
	frUploads <- struct{}{}
	defer func() { <-frUploads }()
	err := f.uploadFile(s, to, dev)
	f.mu.Lock()
	if err != nil {
		s.State, s.Note = "failed", err.Error()
	} else {
		s.State, s.Pct = "done", 100
	}
	f.mu.Unlock()
	if s.remove {
		os.RemoveAll(filepath.Dir(s.path))
	}
}

func (f *Friends) uploadFile(s *frSend, to, dev string) error {
	var st struct {
		ID   string
		Part int64
	}
	if err := f.call("POST", "/send", map[string]any{"to": to, "dev": dev, "name": s.Name, "size": s.size}, &st); err != nil {
		return err
	}
	if st.Part <= 0 {
		st.Part = relayPart
	}
	fh, err := os.Open(s.path)
	if err != nil {
		return err
	}
	defer fh.Close()
	type part struct {
		N    int    `json:"n"`
		Etag string `json:"etag"`
	}
	var parts []part
	var sent int64
	for n := 1; sent < s.size || n == 1; n++ {
		size := min(st.Part, s.size-sent)
		var p part
		if err := f.call("PUT", fmt.Sprintf("/send/%s/%d", st.ID, n), io.NewSectionReader(fh, sent, size), &p); err != nil {
			return err
		}
		parts = append(parts, p)
		sent += size
		f.mu.Lock()
		if s.size > 0 {
			s.Pct = float64(sent) * 100 / float64(s.size)
		}
		f.mu.Unlock()
		if size == 0 {
			break
		}
	}
	return f.call("POST", "/send/"+st.ID+"/done", map[string]any{"parts": parts}, nil)
}

// State is what the Friends page shows.
func (f *Friends) State(from string) map[string]any {
	c := f.a.set.Get()
	f.mu.Lock()
	defer f.mu.Unlock()
	sends := []frSend{}
	for _, s := range f.sends {
		if from == "" || s.From == from {
			sends = append(sends, *s)
		}
	}
	out := map[string]any{"joined": c.FrTok != "", "name": c.FrName, "pc": f.devices()[0].Name, "err": f.err, "sends": sends, "ready": !strings.Contains(relayURL, "REPLACE")}
	if f.last != nil && c.FrTok != "" {
		p := *f.last
		p.People = slices.Clone(p.People) // Send holds pointers into the cached list: sort a copy
		sort.Slice(p.People, func(i, j int) bool {
			if p.People[i].Online != p.People[j].Online {
				return p.People[i].Online
			}
			return strings.ToLower(p.People[i].Name) < strings.ToLower(p.People[j].Name)
		})
		out["me"] = p
	}
	return out
}

func (f *Friends) Admin(what, id string) error {
	if err := f.call("POST", "/"+what+"/"+url.PathEscape(id), nil, nil); err != nil {
		return err
	}
	f.refresh() // the list the screens show; not the inbox, which can take minutes and would hold up the answer
	return nil
}

// jobPaths finds the files a finished job in one of the tools made.
func (a *App) jobPaths(tool, id string) []string {
	var out []string
	switch tool {
	case "dl":
		if j := a.dl.Get(id); j != nil {
			for n := range j.Files {
				if p, ok := a.dl.Path(j, n); ok {
					out = append(out, p)
				}
			}
		}
	case "cv", "pdf", "tr":
		q := map[string]*Converter{"cv": a.cv, "pdf": a.pdf, "tr": a.tr}[tool]
		if j := q.Get(id); j != nil {
			for n := range j.Files {
				if p, ok := q.Path(j, n); ok {
					out = append(out, p)
				}
			}
		}
	case "drop":
		if it := a.drops.Get(id); it != nil {
			for n := range it.Files {
				if p, ok := a.drops.Path(it, n); ok {
					out = append(out, p)
				}
			}
		}
	}
	return out
}
