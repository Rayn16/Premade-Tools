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

// checkUpdate looks for a newer release, like Premade does, and swaps the program in place.
// It needs the repo's releases to be public; until then it just says there's nothing new.
func (a *App) checkUpdate(quiet bool) string {
	cl := &http.Client{Timeout: 30 * time.Second}
	resp, err := cl.Get(releasesAPI)
	if err != nil {
		return "Couldn't reach GitHub to check."
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
		return "You have the newest version."
	}
	for _, as := range rel.Assets {
		if as.Name != "PremadeTools.exe" {
			continue
		}
		if err := swapExe(cl, as.URL); err != nil {
			log.Printf("update: %v", err)
			return "Update failed: " + err.Error()
		}
		a.upd = strings.TrimPrefix(rel.Tag, "v")
		go func() { time.Sleep(2 * time.Second); restart() }()
		return "Updating to " + a.upd + ". The window reopens in a moment."
	}
	return "You have the newest version."
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
