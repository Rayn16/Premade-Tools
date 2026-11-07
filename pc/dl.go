package main

// The Downloader: one box, any link. yt-dlp works out the site itself; picture posts it can't read go to
// gallery-dl. Jobs run one at a time at low priority, files land in the download folder, and a phone that sent
// the link fetches the result back into its Photos or Gallery.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type DLFile struct {
	Name string `json:"name"` // relative to the download folder
	Size int64  `json:"size"`
	Kind string `json:"kind"` // video, photo, audio, file
}

type Job struct {
	ID      string    `json:"id"`
	URL     string    `json:"url"`
	Key     string    `json:"key,omitempty"` // site:id, to spot repeats
	Site    string    `json:"site"`
	Title   string    `json:"title"`
	What    string    `json:"what"`
	Audio   bool      `json:"audio,omitempty"`
	Mode    string    `json:"mode,omitempty"` // "" (single), one, all
	Engine  string    `json:"engine"`
	Count   int       `json:"count,omitempty"` // items in a playlist download
	From    string    `json:"from"`            // phone id, or "" for this PC
	State   string    `json:"state"`           // queued, running, done, failed
	Pct     float64   `json:"pct"`
	Note    string    `json:"note,omitempty"`  // the error, in plain words
	Login   string    `json:"login,omitempty"` // site that wants a login
	Files   []DLFile  `json:"files,omitempty"`
	Size    int64     `json:"size"`
	At      time.Time `json:"at"`
	Fetched bool      `json:"fetched,omitempty"` // the phone saved it
}

type Probe struct {
	Site     string `json:"site"`
	Title    string `json:"title"`
	What     string `json:"what"`
	Key      string `json:"key"`
	Engine   string `json:"engine"`
	Count    int    `json:"count"` // videos in a playlist; 0 for one item
	Ask      bool   `json:"ask"`   // a playlist to ask about: all of it, or just the one
	Pictures bool   `json:"pictures"`
	Err      string `json:"err,omitempty"`
	Login    string `json:"login,omitempty"`
	at       time.Time
}

type Downloader struct {
	mu      sync.Mutex
	path    string
	jobs    []*Job // newest first
	probes  map[string]*Probe
	cancel  map[string]context.CancelFunc
	wake    chan struct{}
	eng     *Engines
	dir     func() string
	cookies string
}

func NewDownloader(eng *Engines, dir func() string) *Downloader {
	d := &Downloader{path: filepath.Join(appDir(), "downloads.json"), probes: map[string]*Probe{}, cancel: map[string]context.CancelFunc{},
		wake: make(chan struct{}, 1), eng: eng, dir: dir, cookies: filepath.Join(appDir(), "cookies.txt")}
	if b, err := os.ReadFile(d.path); err == nil {
		json.Unmarshal(b, &d.jobs)
	}
	for _, j := range d.jobs { // the program stopped mid-download: try again
		if j.State == "running" {
			j.State, j.Pct = "queued", 0
		}
	}
	go d.worker()
	return d
}

func (d *Downloader) saveLocked() {
	if len(d.jobs) > 500 {
		d.jobs = d.jobs[:500]
	}
	writeJSON(d.path, d.jobs)
}

func (d *Downloader) Jobs(from string) []Job {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := []Job{}
	for _, j := range d.jobs {
		if from == "" || j.From == from {
			out = append(out, *j)
		}
	}
	return out
}

func (d *Downloader) Get(id string) *Job {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, j := range d.jobs {
		if j.ID == id {
			c := *j
			return &c
		}
	}
	return nil
}

func (d *Downloader) update(id string, f func(j *Job)) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, j := range d.jobs {
		if j.ID == id {
			f(j)
			if j.State != "running" {
				d.saveLocked()
			}
		}
	}
}

var urlRe = regexp.MustCompile(`https?://[^\s"'<>]+`)

// cleanURL finds the link in what was pasted or shared ("Look at this! https://vm.tiktok.com/…").
func cleanURL(s string) string {
	if m := urlRe.FindString(s); m != "" {
		return strings.TrimRight(m, ".,;!?)")
	}
	s = strings.TrimSpace(s)
	if strings.Contains(s, ".") && !strings.ContainsAny(s, " \n") {
		return "https://" + s
	}
	return ""
}

// Start checks the link and queues it. It returns the probe without a job when the person has to answer first
// (a playlist) or when it fails; repeat is set when this link was downloaded before.
func (d *Downloader) Start(raw string, audio bool, mode string, force bool, from string) (job *Job, p *Probe, repeat *Job) {
	u := cleanURL(raw)
	if u == "" {
		return nil, &Probe{Err: "That doesn't look like a link. Copy the link from the app's Share button and paste it here."}, nil
	}
	p = d.Probe(u)
	if p.Err != "" {
		return nil, p, nil
	}
	if p.Ask && mode == "" {
		return nil, p, nil
	}
	if !force {
		d.mu.Lock()
		for _, j := range d.jobs {
			if j.Key == p.Key && j.Audio == audio && j.State != "failed" && (mode == "" || j.Mode == mode) {
				c := *j
				repeat = &c
				break
			}
		}
		d.mu.Unlock()
		if repeat != nil {
			return nil, p, repeat
		}
	}
	j := &Job{ID: randCode(5), URL: u, Key: p.Key, Site: p.Site, Title: p.Title, What: p.What, Audio: audio && !p.Pictures, Mode: mode,
		Engine: p.Engine, From: from, State: "queued", At: time.Now()}
	if p.Ask && mode == "one" {
		j.What = "1 video from the playlist"
	}
	if j.Audio {
		j.What = "Sound only, MP3"
		if mode == "all" {
			j.What = fmt.Sprintf("%d songs as MP3", p.Count)
		}
	}
	if mode == "all" {
		j.Count = p.Count
	}
	d.mu.Lock()
	d.jobs = append([]*Job{j}, d.jobs...)
	d.saveLocked()
	d.mu.Unlock()
	select {
	case d.wake <- struct{}{}:
	default:
	}
	c := *j
	return &c, p, nil
}

func (d *Downloader) Cancel(id string) {
	d.mu.Lock()
	if c := d.cancel[id]; c != nil {
		c()
	}
	d.mu.Unlock()
	d.update(id, func(j *Job) {
		if j.State == "queued" || j.State == "running" {
			j.State, j.Note = "failed", "Cancelled."
		}
	})
}

func (d *Downloader) Remove(id string) {
	d.Cancel(id)
	d.mu.Lock()
	defer d.mu.Unlock()
	for i, j := range d.jobs {
		if j.ID == id {
			d.jobs = append(d.jobs[:i], d.jobs[i+1:]...)
			d.saveLocked()
			return
		}
	}
}

// Probe asks the engines what a link is. Results are kept for 10 minutes, so checking as you paste and then
// pressing Download costs one look.
func (d *Downloader) Probe(u string) *Probe {
	d.mu.Lock()
	if p := d.probes[u]; p != nil && time.Since(p.at) < 10*time.Minute {
		d.mu.Unlock()
		return p
	}
	d.mu.Unlock()
	p := d.probe(u)
	p.at = time.Now()
	if p.Err == "" { // failures aren't kept, so logging in and trying again works at once
		d.mu.Lock()
		d.probes[u] = p
		d.mu.Unlock()
	}
	return p
}

func (d *Downloader) cookieArgs() []string {
	if _, err := os.Stat(d.cookies); err == nil {
		return []string{"--cookies", d.cookies}
	}
	return nil
}

func (d *Downloader) ytArgs() []string {
	args := []string{"--ignore-config", "--no-colors", "--no-warnings", "--windows-filenames", "--no-mtime"}
	if dir := filepath.Dir(d.eng.Bin("ffmpeg")); dir != "." {
		args = append(args, "--ffmpeg-location", dir, "--js-runtimes", "deno:"+d.eng.Bin("deno"))
	}
	return append(args, d.cookieArgs()...)
}

func (d *Downloader) probe(u string) *Probe {
	if !d.eng.Ready() {
		return &Probe{Err: "The download engines are still being set up. Try again in a minute."}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := hidden(exec.CommandContext(ctx, d.eng.Bin("yt-dlp"), append(d.ytArgs(), "-J", "--flat-playlist", "--", u)...))
	var errb strings.Builder
	cmd.Stderr = &errb
	out, err := cmd.Output()
	if err == nil {
		if p := parseProbe(out); p != nil {
			if p.Site == "Generic" {
				p.Site = siteOf(u)
			}
			return p
		}
	}
	yterr := lastError(errb.String())
	if ctx.Err() != nil {
		yterr = "The site took too long to answer."
	}
	// Picture posts (and sites yt-dlp doesn't know) go to gallery-dl.
	if g := d.probeGallery(u); g != nil {
		return g
	}
	return explain(yterr, siteOf(u))
}

func (d *Downloader) probeGallery(u string) *Probe {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := hidden(exec.CommandContext(ctx, d.eng.Bin("gallery-dl"), append([]string{"--config-ignore", "-g"}, append(d.cookieArgs(), "--", u)...)...))
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	n := 0
	for _, l := range strings.Split(string(out), "\n") {
		if l = strings.TrimSpace(l); strings.HasPrefix(l, "http") || strings.HasPrefix(l, "ytdl:") {
			n++
		}
	}
	if n == 0 {
		return nil
	}
	site := siteOf(u)
	what := fmt.Sprintf("%d pictures", n)
	if n == 1 {
		what = "1 picture"
	}
	return &Probe{Site: site, Title: site + " post", What: what, Key: "gallery:" + u, Engine: "gallery-dl", Pictures: true}
}

// parseProbe reads yt-dlp's -J answer.
func parseProbe(b []byte) *Probe {
	var in struct {
		Type     string  `json:"_type"`
		ID       string  `json:"id"`
		Title    string  `json:"title"`
		Extr     string  `json:"extractor_key"`
		Duration float64 `json:"duration"`
		Count    int     `json:"playlist_count"`
		Entries  []struct {
			Title string `json:"title"`
		} `json:"entries"`
	}
	if json.Unmarshal(b, &in) != nil || in.Extr == "" {
		return nil
	}
	site := siteName(in.Extr)
	p := &Probe{Site: site, Title: in.Title, Key: in.Extr + ":" + in.ID, Engine: "yt-dlp"}
	if in.Type == "playlist" {
		n := len(in.Entries)
		if in.Count > n {
			n = in.Count
		}
		if n == 0 {
			return nil // an empty "playlist" is usually a picture post; let gallery-dl try
		}
		p.Count = n
		p.What = fmt.Sprintf("Playlist, %d videos", n)
		// Posts with a few clips (Instagram, X, TikTok) just come down whole; real playlists ask first.
		switch in.Extr {
		case "Instagram", "Twitter", "TikTok", "Reddit", "Facebook", "Threads", "Bluesky":
			p.What = fmt.Sprintf("%d videos", n)
			if n == 1 {
				p.What, p.Count = "Video", 0
				if len(in.Entries) == 1 && in.Entries[0].Title != "" {
					p.Title = in.Entries[0].Title
				}
			}
		default:
			p.Ask = n > 1
		}
		return p
	}
	p.What = "Video"
	if in.Duration > 0 {
		p.What += ", " + clock(in.Duration)
	}
	return p
}

func clock(sec float64) string {
	s := int(sec + 0.5)
	if s >= 3600 {
		return fmt.Sprintf("%d:%02d:%02d", s/3600, s/60%60, s%60)
	}
	return fmt.Sprintf("%d:%02d", s/60, s%60)
}

func siteName(extr string) string {
	switch extr {
	case "Youtube", "YoutubeTab":
		return "YouTube"
	case "Twitter":
		return "X"
	case "TikTok", "TikTokUser", "TikTokVM":
		return "TikTok"
	}
	return strings.TrimSuffix(strings.TrimSuffix(extr, "Tab"), "Playlist")
}

func siteOf(u string) string {
	pu, err := url.Parse(u)
	if err != nil {
		return "That site"
	}
	h := strings.TrimPrefix(pu.Hostname(), "www.")
	for k, v := range map[string]string{"x.com": "X", "twitter.com": "X", "instagram.com": "Instagram", "tiktok.com": "TikTok", "youtube.com": "YouTube", "youtu.be": "YouTube",
		"reddit.com": "Reddit", "redd.it": "Reddit", "facebook.com": "Facebook", "fb.watch": "Facebook", "pinterest.com": "Pinterest", "pin.it": "Pinterest", "snapchat.com": "Snapchat", "threads.net": "Threads"} {
		if h == k || strings.HasSuffix(h, "."+k) {
			return v
		}
	}
	return h
}

func lastError(s string) string {
	last := ""
	for _, l := range strings.Split(s, "\n") {
		if strings.HasPrefix(l, "ERROR:") {
			last = l
		}
	}
	return strings.TrimSpace(last)
}

var errPrefix = regexp.MustCompile(`^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]+:\s)?`)

// explain turns an engine's error into words for a person.
func explain(msg, site string) *Probe {
	l := strings.ToLower(msg)
	switch {
	case strings.Contains(l, "drm"):
		return &Probe{Site: site, Err: site + " protects this with DRM, so no downloader can save it."}
	case strings.Contains(l, "login") || strings.Contains(l, "log in") || strings.Contains(l, "cookies") || strings.Contains(l, "sign in") || strings.Contains(l, "private"):
		return &Probe{Site: site, Login: site, Err: site + " only shows this to logged-in people. Log in once in Settings › Logins and try again."}
	case strings.Contains(l, "unsupported url") || msg == "":
		return &Probe{Site: site, Err: "Nothing to download was found at that link. Check it opens a post or video, not a profile or search page."}
	case strings.Contains(l, "unable to download") || strings.Contains(l, "timed out") || strings.Contains(l, "too long"):
		return &Probe{Site: site, Err: site + " didn't answer. Check the PC is online and try again."}
	}
	return &Probe{Site: site, Err: strings.TrimSpace(errPrefix.ReplaceAllString(msg, ""))}
}

func (d *Downloader) worker() {
	for {
		var next *Job
		d.mu.Lock()
		for i := len(d.jobs) - 1; i >= 0; i-- { // oldest queued first
			if d.jobs[i].State == "queued" {
				next = d.jobs[i]
				break
			}
		}
		var id string
		if next != nil {
			next.State = "running"
			id = next.ID
		}
		d.mu.Unlock()
		if next == nil {
			<-d.wake
			continue
		}
		d.run(id)
	}
}

func (d *Downloader) run(id string) {
	j := d.Get(id)
	dir := d.dir()
	ctx, cancel := context.WithCancel(context.Background())
	d.mu.Lock()
	d.cancel[id] = cancel
	d.mu.Unlock()
	defer func() {
		cancel()
		d.mu.Lock()
		delete(d.cancel, id)
		d.mu.Unlock()
	}()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		d.update(id, func(j *Job) { j.State, j.Note = "failed", "Can't use the download folder: "+err.Error() })
		return
	}
	var files []string
	var err error
	if j.Engine == "gallery-dl" {
		files, err = d.runGallery(ctx, j, dir)
	} else {
		files, err = d.runYt(ctx, j, dir)
	}
	if ctx.Err() != nil {
		return // cancelled; Cancel already marked it
	}
	var out []DLFile
	var size int64
	for _, f := range files {
		fi, e := os.Stat(f)
		if e != nil {
			continue
		}
		rel, _ := filepath.Rel(dir, f)
		out = append(out, DLFile{Name: rel, Size: fi.Size(), Kind: fileKind(f)})
		size += fi.Size()
	}
	d.update(id, func(j *Job) {
		j.Files, j.Size, j.Pct = out, size, 100
		switch {
		case len(out) > 0:
			j.State = "done"
			if err != nil {
				j.Note = fmt.Sprintf("Some items couldn't be saved: %v", err)
			}
		case err != nil:
			p := explain(err.Error(), j.Site)
			j.State, j.Note, j.Login = "failed", p.Err, p.Login
		default:
			j.State, j.Note = "failed", "The site sent nothing to save."
		}
	})
	if j.From == "" {
		if jj := d.Get(id); jj != nil && jj.State == "done" {
			notify("Downloader", "Saved: "+jj.Title)
		}
	}
}

var progRe = regexp.MustCompile(`^@@(\S+) (\S+) (\S+)`)

func (d *Downloader) runYt(ctx context.Context, j *Job, dir string) ([]string, error) {
	tmp := filepath.Join(appDir(), "dl-tmp")
	args := append(d.ytArgs(), "--newline", "--progress", "-P", dir, "-P", "temp:"+tmp,
		"--progress-template", "download:@@%(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
		"--print", "after_move:@@FILE %(filepath)s")
	if j.Audio {
		args = append(args, "-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0")
	} else {
		// H.264 MP4 first: it plays and saves everywhere, iPhone Photos included.
		args = append(args, "-f", "bv*+ba/b", "-S", "vcodec:h264,res,acodec:aac", "--merge-output-format", "mp4")
	}
	switch j.Mode {
	case "all":
		args = append(args, "--yes-playlist", "-o", "%(playlist_title).80B/%(playlist_index)03d %(title).100B.%(ext)s")
	case "one":
		args = append(args, "--no-playlist", "--playlist-items", "1", "-o", "%(title).120B [%(id)s].%(ext)s")
	default:
		args = append(args, "-o", "%(title).120B [%(id)s].%(ext)s")
	}
	cmd := hidden(exec.CommandContext(ctx, d.eng.Bin("yt-dlp"), append(args, "--", j.URL)...))
	var errb strings.Builder
	cmd.Stderr = &errb
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	var files []string
	sc := bufio.NewScanner(stdout)
	for sc.Scan() {
		l := sc.Text()
		if f, ok := strings.CutPrefix(l, "@@FILE "); ok {
			files = append(files, f)
			continue
		}
		if m := progRe.FindStringSubmatch(l); m != nil {
			got, _ := strconv.ParseFloat(m[1], 64)
			tot, _ := strconv.ParseFloat(m[2], 64)
			if tot == 0 {
				tot, _ = strconv.ParseFloat(m[3], 64)
			}
			if tot > 0 {
				pct := got / tot * 100
				if j.Count > 1 { // a playlist: whole items done plus this one's share
					pct = (float64(len(files)) + got/tot) / float64(j.Count) * 100
				}
				d.update(j.ID, func(j *Job) { j.Pct = min(pct, 99) })
			}
		}
	}
	err := cmd.Wait()
	if err != nil {
		if e := lastError(errb.String()); e != "" {
			err = fmt.Errorf("%s", e)
		}
		log.Printf("yt-dlp %s: %v", j.URL, err)
	}
	return files, err
}

func (d *Downloader) runGallery(ctx context.Context, j *Job, dir string) ([]string, error) {
	args := append([]string{"--config-ignore", "-D", dir}, d.cookieArgs()...)
	cmd := hidden(exec.CommandContext(ctx, d.eng.Bin("gallery-dl"), append(args, "--", j.URL)...))
	var errb strings.Builder
	cmd.Stderr = &errb
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	var files []string
	sc := bufio.NewScanner(stdout)
	for sc.Scan() {
		l := strings.TrimSpace(sc.Text())
		l = strings.TrimPrefix(l, "# ") // "# path" means it was already there
		if filepath.IsAbs(l) {
			files = append(files, l)
			d.update(j.ID, func(j *Job) { j.Pct = min(float64(len(files))*10, 95) })
		}
	}
	err := cmd.Wait()
	if err != nil {
		if e := strings.TrimSpace(errb.String()); e != "" {
			err = fmt.Errorf("ERROR: %s", e[strings.LastIndex(e, "\n")+1:])
		}
	}
	return files, err
}

func fileKind(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".mp4", ".mov", ".m4v", ".webm", ".mkv":
		return "video"
	case ".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".avif":
		return "photo"
	case ".mp3", ".m4a", ".aac", ".opus", ".ogg", ".wav", ".flac":
		return "audio"
	}
	return "file"
}

// Path gives a job's file on disk, refusing anything outside the download folder.
func (d *Downloader) Path(j *Job, n int) (string, bool) {
	if n < 0 || n >= len(j.Files) {
		return "", false
	}
	dir := d.dir()
	p := filepath.Join(dir, j.Files[n].Name)
	if rel, err := filepath.Rel(dir, p); err != nil || strings.HasPrefix(rel, "..") {
		return "", false
	}
	return p, true
}
