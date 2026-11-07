package main

// The Downloader's engines: yt-dlp (videos from ~1,700 sites), gallery-dl (picture posts), FFmpeg (joins video
// and sound, makes MP3s) and Deno (solves YouTube's scrambling for yt-dlp). They're free programs fetched from
// their own GitHub releases into the app folder, and yt-dlp and gallery-dl are refreshed every 6 hours so a site
// that changed is usually fixed the same day.

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

type engine struct {
	Name, Repo, Asset string   // Asset is a regexp for the release file
	Inner             []string // files to take out of a zip
	Every             time.Duration
}

var engineList = []engine{
	{"yt-dlp", "yt-dlp/yt-dlp", `^yt-dlp\.exe$`, nil, 6 * time.Hour},
	{"gallery-dl", "mikf/gallery-dl", `^gallery-dl\.exe$`, nil, 6 * time.Hour},
	{"ffmpeg", "yt-dlp/FFmpeg-Builds", `^ffmpeg-n[0-9.]+-latest-win64-gpl-[0-9.]+\.zip$`, []string{"ffmpeg.exe", "ffprobe.exe"}, 30 * 24 * time.Hour},
	{"deno", "denoland/deno", `^deno-x86_64-pc-windows-msvc\.zip$`, []string{"deno.exe"}, 30 * 24 * time.Hour},
}

type EngineState struct {
	Name    string    `json:"name"`
	Version string    `json:"version"`
	Checked time.Time `json:"checked"`
	State   string    `json:"state"` // ok, installing, missing, error
	Err     string    `json:"err,omitempty"`
}

type Engines struct {
	mu      sync.Mutex
	dir     string
	nightly func() bool
	st      map[string]*EngineState
	busy    sync.Mutex // one install or update at a time
}

func NewEngines(nightly func() bool) *Engines {
	e := &Engines{dir: filepath.Join(appDir(), "engines"), nightly: nightly, st: map[string]*EngineState{}}
	os.MkdirAll(e.dir, 0o755)
	if b, err := os.ReadFile(filepath.Join(e.dir, "versions.json")); err == nil {
		json.Unmarshal(b, &e.st)
	}
	for _, en := range engineList {
		s := e.st[en.Name]
		if s == nil {
			s = &EngineState{Name: en.Name}
			e.st[en.Name] = s
		}
		s.State = "ok"
		if !e.present(en) {
			s.State = "missing"
		}
	}
	return e
}

// Bin is the path to run an engine by. Off Windows (development) the engines come from PATH.
func (e *Engines) Bin(name string) string {
	if runtime.GOOS != "windows" {
		return name
	}
	return filepath.Join(e.dir, name+".exe")
}

func (e *Engines) present(en engine) bool {
	if runtime.GOOS != "windows" {
		return true
	}
	_, err := os.Stat(e.Bin(en.Name))
	return err == nil
}

func (e *Engines) List() []EngineState {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := []EngineState{}
	for _, en := range engineList {
		out = append(out, *e.st[en.Name])
	}
	return out
}

// Ready says whether the two engines a download needs at all are there.
func (e *Engines) Ready() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.st["yt-dlp"].State != "missing" && e.st["ffmpeg"].State != "missing"
}

func (e *Engines) set(name string, f func(s *EngineState)) {
	e.mu.Lock()
	f(e.st[name])
	writeJSON(filepath.Join(e.dir, "versions.json"), e.st)
	e.mu.Unlock()
}

// Update installs missing engines and refreshes those that are due (all of them when force is set).
func (e *Engines) Update(force bool) {
	if runtime.GOOS != "windows" {
		return
	}
	e.busy.Lock()
	defer e.busy.Unlock()
	for _, en := range engineList {
		e.mu.Lock()
		s := *e.st[en.Name]
		e.mu.Unlock()
		if s.State != "missing" && !force && time.Since(s.Checked) < en.Every {
			continue
		}
		if err := e.fetch(en, s.Version, s.State == "missing"); err != nil {
			log.Printf("engine %s: %v", en.Name, err)
			e.set(en.Name, func(s *EngineState) {
				s.Err = err.Error()
				if !e.present(en) {
					s.State = "error"
				} else {
					s.State = "ok"
				}
			})
		}
	}
}

type ghRelease struct {
	Tag    string `json:"tag_name"`
	Assets []struct {
		Name    string `json:"name"`
		URL     string `json:"browser_download_url"`
		Updated string `json:"updated_at"`
	} `json:"assets"`
}

func (e *Engines) fetch(en engine, have string, missing bool) error {
	repo := en.Repo
	if en.Name == "yt-dlp" && e.nightly() {
		repo = "yt-dlp/yt-dlp-nightly-builds"
	}
	cl := &http.Client{Timeout: 20 * time.Minute}
	resp, err := cl.Get("https://api.github.com/repos/" + repo + "/releases/latest")
	if err != nil {
		return fmt.Errorf("couldn't reach GitHub")
	}
	var rel ghRelease
	err = json.NewDecoder(resp.Body).Decode(&rel)
	resp.Body.Close()
	if resp.StatusCode != 200 || err != nil {
		return fmt.Errorf("GitHub said %s", resp.Status)
	}
	re := regexp.MustCompile(en.Asset)
	for _, as := range rel.Assets {
		if !re.MatchString(as.Name) {
			continue
		}
		ver := rel.Tag
		if en.Name == "ffmpeg" { // that repo keeps one "latest" release and replaces its files
			ver = strings.TrimSuffix(strings.TrimPrefix(as.Name, "ffmpeg-"), "-latest-win64-gpl") + " " + as.Updated[:10]
		}
		if ver == have && !missing {
			e.set(en.Name, func(s *EngineState) { s.Checked, s.Err = time.Now(), "" })
			return nil
		}
		e.set(en.Name, func(s *EngineState) { s.State = "installing" })
		if err := e.download(cl, en, as.URL); err != nil {
			return err
		}
		e.set(en.Name, func(s *EngineState) { s.Version, s.Checked, s.State, s.Err = ver, time.Now(), "ok", "" })
		log.Printf("engine %s %s installed", en.Name, ver)
		return nil
	}
	return fmt.Errorf("no %s file in %s's latest release", en.Name, repo)
}

func (e *Engines) download(cl *http.Client, en engine, url string) error {
	resp, err := cl.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download: %s", resp.Status)
	}
	tmp := filepath.Join(e.dir, en.Name+".download")
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, resp.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	defer os.Remove(tmp)
	if err != nil {
		return err
	}
	if en.Inner == nil {
		return replaceFile(tmp, e.Bin(en.Name))
	}
	zr, err := zip.OpenReader(tmp)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, want := range en.Inner {
		found := false
		for _, zf := range zr.File {
			if filepath.Base(zf.Name) != want {
				continue
			}
			found = true
			if err := unzipOne(zf, filepath.Join(e.dir, want)); err != nil {
				return err
			}
		}
		if !found {
			return fmt.Errorf("%s missing from the download", want)
		}
	}
	return nil
}

func unzipOne(zf *zip.File, dst string) error {
	r, err := zf.Open()
	if err != nil {
		return err
	}
	defer r.Close()
	tmp := dst + ".new"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	return replaceFile(tmp, dst)
}

// replaceFile swaps in a new copy even while the old one runs (Windows allows renaming a running exe).
func replaceFile(src, dst string) error {
	os.Remove(dst + ".old")
	if _, err := os.Stat(dst); err == nil {
		if err := os.Rename(dst, dst+".old"); err != nil {
			return err
		}
	}
	if err := os.Rename(src, dst); err != nil {
		return copyFile(src, dst)
	}
	return nil
}
