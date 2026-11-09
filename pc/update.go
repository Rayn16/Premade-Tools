package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

var releasesAPI = "https://api.github.com/repos/Rayn16/Premade-Tools/releases/latest"

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
	if resp.StatusCode != 200 {
		return release{}, fmt.Errorf("GitHub said %s", resp.Status)
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return release{}, err
	}
	if !newer(rel.Tag, version) {
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

var updating sync.Mutex

// checkUpdate is the Update button. It answers at once (a phone asking through the relay would time out on a
// 16 MB download), then downloads, swaps the exe and restarts in the background. A failure shows in the pop-up.
func (a *App) checkUpdate() string {
	if !updating.TryLock() { // held until the restart
		return "Updating. Premade Tools restarts in a moment."
	}
	a.setUpdErr("")
	r, err := latest(&http.Client{Timeout: 30 * time.Second})
	if err != nil || r.url == "" {
		updating.Unlock()
		if err != nil {
			log.Printf("update: %v", err)
			return "Update failed: can't reach GitHub. " + err.Error()
		}
		return "You have the newest version."
	}
	go func() {
		if err := swapExe(r.url); err != nil {
			log.Printf("update: %v", err)
			a.setUpdErr("Update failed: " + err.Error())
			updating.Unlock()
			return
		}
		restart()
	}()
	return "Updating to " + r.ver + ". Premade Tools restarts in a moment."
}

func (a *App) setUpdErr(s string) {
	a.mu.Lock()
	a.updErr = s
	a.mu.Unlock()
}

func (a *App) updFailed() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.updErr
}

// swapExe downloads the new exe next to the running one (three tries) and swaps them.
func swapExe(url string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	for try := 0; ; try++ {
		if err = getExe(url, exe+".new"); err == nil || try == 2 {
			break
		}
		time.Sleep(3 * time.Second)
	}
	if err != nil {
		os.Remove(exe + ".new")
		return err
	}
	os.Remove(exe + ".old")
	// Windows lets a running exe be renamed, not replaced. An antivirus scanning the new file can hold it for a moment.
	for try := 0; ; try++ {
		if err = os.Rename(exe, exe+".old"); err == nil || try == 9 {
			break
		}
		time.Sleep(time.Second)
	}
	if err != nil {
		return err
	}
	for try := 0; ; try++ {
		if err = os.Rename(exe+".new", exe); err == nil || try == 9 {
			break
		}
		time.Sleep(time.Second)
	}
	if err != nil {
		os.Rename(exe+".old", exe) // put the working one back
	}
	return err
}

// getExe downloads the release exe and makes sure it is one, so a cut-off file never replaces a working program.
func getExe(url, dst string) error {
	if err := download(&http.Client{Timeout: 10 * time.Minute}, url, dst, func(float64) {}); err != nil {
		return err
	}
	b := make([]byte, 2)
	if f, err := os.Open(dst); err == nil {
		f.Read(b)
		f.Close()
	}
	if fi, err := os.Stat(dst); err != nil || fi.Size() < 1<<20 || string(b) != "MZ" {
		return fmt.Errorf("the download came out broken, try again")
	}
	return nil
}

func cleanOldExe() {
	if exe, err := os.Executable(); err == nil {
		os.Remove(exe + ".old")
		os.Remove(exe + ".new")
	}
}

// restart starts the new copy first and then quits. The new copy waits for the port (see main), so there is
// no moment where nothing is running and nothing can quit the old copy before the new one has started.
func restart() {
	exe, _ := os.Executable()
	if err := exec.Command(exe, "--background", "--restarted").Start(); err != nil {
		log.Printf("restart: %v", err)
		if os.Rename(exe, exe+".bad") == nil && os.Rename(exe+".old", exe) == nil {
			exec.Command(exe, "--background", "--restarted").Start()
		}
	}
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
