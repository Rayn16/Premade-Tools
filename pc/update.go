package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const releasesAPI = "https://api.github.com/repos/Rayn16/Premade-Tools/releases/latest"

type release struct {
	ver, url string // url is "" when there's nothing newer
}

// latest asks GitHub for the newest release. It needs the repo's releases to be public.
func latest(cl *http.Client) (release, error) {
	resp, err := cl.Get(releasesAPI)
	if err != nil {
		return release{}, err
	}
	defer resp.Body.Close()
	var rel struct {
		Tag    string `json:"tag_name"`
		Assets []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&rel) != nil || !newer(rel.Tag, version) {
		return release{}, nil
	}
	for _, as := range rel.Assets {
		if as.Name == "PremadeTools.exe" {
			return release{strings.TrimPrefix(rel.Tag, "v"), as.URL}, nil
		}
	}
	return release{}, nil
}

// findUpdate notes a newer release so the window and the phones can offer it. It doesn't install anything.
func (a *App) findUpdate() {
	r, err := latest(&http.Client{Timeout: 30 * time.Second})
	if err != nil || r.url == "" {
		return
	}
	a.mu.Lock()
	fresh := a.upd != r.ver
	a.upd = r.ver
	a.mu.Unlock()
	if fresh {
		notify("Premade Tools", "Version "+r.ver+" is ready. Open Premade Tools to update.")
	}
}

// checkUpdate is the Update button: it installs the newest release and restarts.
func (a *App) checkUpdate() string {
	a.mu.Lock()
	busy := a.updating
	a.updating = true
	a.mu.Unlock()
	if busy {
		return "Updating. The window reopens in a moment."
	}
	cl := &http.Client{Timeout: 5 * time.Minute}
	r, err := latest(cl)
	if err == nil && r.url != "" {
		err = swapExe(cl, r.url)
	}
	if err != nil || r.url == "" {
		a.mu.Lock()
		a.updating = false
		a.mu.Unlock()
		if err != nil {
			log.Printf("update: %v", err)
			return "Update failed: " + err.Error()
		}
		return "You have the newest version."
	}
	go func() { time.Sleep(2 * time.Second); restart() }()
	return "Updating to " + r.ver + ". The window reopens in a moment."
}

func swapExe(cl *http.Client, url string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	resp, err := cl.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download: %s", resp.Status)
	}
	f, err := os.Create(exe + ".new")
	if err != nil {
		return err
	}
	if _, err = io.Copy(f, resp.Body); err == nil {
		err = f.Close()
	} else {
		f.Close()
	}
	if err != nil {
		return err
	}
	os.Remove(exe + ".old")
	if err := os.Rename(exe, exe+".old"); err != nil { // Windows lets a running exe be renamed, not replaced
		return err
	}
	return os.Rename(exe+".new", exe)
}

func cleanOldExe() {
	if exe, err := os.Executable(); err == nil {
		os.Remove(exe + ".old")
	}
}

func restart() {
	exe, _ := os.Executable()
	listener.Close() // free the port for the new copy
	exec.Command(exe, "--background").Start()
	os.Exit(0)
}

// newer compares versions like 0.1.10 > 0.1.9.
func newer(tag, cur string) bool {
	a, b := strings.Split(strings.TrimPrefix(tag, "v"), "."), strings.Split(cur, ".")
	for i := 0; i < len(a) || i < len(b); i++ {
		x, y := 0, 0
		if i < len(a) {
			x, _ = strconv.Atoi(a[i])
		}
		if i < len(b) {
			y, _ = strconv.Atoi(b[i])
		}
		if x != y {
			return x > y
		}
	}
	return false
}
