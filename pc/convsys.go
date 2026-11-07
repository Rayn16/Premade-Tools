package main

import (
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/bodgit/sevenzip"
)

// unpack7z unpacks a whole .7z into dir, swapping out the old copy only once the new one is complete.
func unpack7z(archive, dir string) error {
	r, err := sevenzip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer r.Close()
	tmp := dir + ".new"
	os.RemoveAll(tmp)
	for _, f := range r.File {
		p := filepath.Join(tmp, filepath.FromSlash(f.Name))
		if rel, err := filepath.Rel(tmp, p); err != nil || strings.HasPrefix(rel, "..") {
			continue
		}
		if f.FileInfo().IsDir() {
			os.MkdirAll(p, 0o755)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		if err := extract7z(f, p); err != nil {
			os.RemoveAll(tmp)
			return err
		}
	}
	// Some builds wrap everything in one folder: lift it up so magick.exe sits at the top.
	if ents, _ := os.ReadDir(tmp); len(ents) == 1 && ents[0].IsDir() {
		inner := filepath.Join(tmp, ents[0].Name())
		os.Rename(inner, tmp+".x")
		os.RemoveAll(tmp)
		os.Rename(tmp+".x", tmp)
	}
	os.RemoveAll(dir + ".old")
	os.Rename(dir, dir+".old") // a running copy can't be deleted, but it can be moved
	if err := os.Rename(tmp, dir); err != nil {
		return err
	}
	os.RemoveAll(dir + ".old")
	return nil
}

func extract7z(f *sevenzip.File, dst string) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, rc)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}

// cvBin is the path to run one of the Converter's engines by, or "" when it isn't there yet.
func (a *App) cvBin(name string) string {
	if name == "soffice" {
		return officeBin()
	}
	if runtime.GOOS != "windows" { // development: from PATH (ImageMagick 6 calls itself convert)
		for _, n := range []string{name, map[string]string{"magick": "convert"}[name]} {
			if p, err := exec.LookPath(n); n != "" && err == nil {
				return p
			}
		}
		return ""
	}
	p := a.eng.Bin(name)
	if _, err := os.Stat(p); err != nil {
		return ""
	}
	return p
}

// A free program installed with Windows' own winget the first time it's needed. Windows asks once to allow it.
type installer struct {
	sync.Mutex
	busy           bool
	err            string
	id, name, site string // winget id, what to call it, where to get it by hand
	bin            func() string
	tool, doneNote string // the Windows notification when it's in
}

var office = &installer{id: "TheDocumentFoundation.LibreOffice", name: "LibreOffice", site: "libreoffice.org", bin: officeBin,
	tool: "Converter", doneNote: "LibreOffice is installed. Office files can be converted now."}

// State is "ok", "installing", "missing" or "error: why".
func (s *installer) State() string {
	s.Lock()
	defer s.Unlock()
	switch {
	case s.bin() != "":
		return "ok"
	case s.busy:
		return "installing"
	case s.err != "":
		return "error: " + s.err
	}
	return "missing"
}

func (s *installer) Install() {
	s.Lock()
	if s.busy || s.bin() != "" {
		s.Unlock()
		return
	}
	s.busy, s.err = true, ""
	s.Unlock()
	err := func() error {
		if runtime.GOOS != "windows" {
			return fmt.Errorf("installing needs Windows")
		}
		wg, err := exec.LookPath("winget")
		if err != nil {
			wg = filepath.Join(os.Getenv("LOCALAPPDATA"), "Microsoft", "WindowsApps", "winget.exe")
		}
		out, err := hidden(exec.Command(wg, "install", "--id", s.id, "-e", "--silent",
			"--accept-package-agreements", "--accept-source-agreements")).CombinedOutput()
		if s.bin() != "" {
			return nil
		}
		log.Printf("winget %s: %v %s", s.id, err, out)
		if err != nil && strings.Contains(err.Error(), "file") {
			return fmt.Errorf("this PC has no winget. Install %s from %s, then come back", s.name, s.site)
		}
		return fmt.Errorf("it didn't finish. Try again, or install it from %s", s.site)
	}()
	s.Lock()
	s.busy = false
	if err != nil {
		s.err = err.Error()
	}
	s.Unlock()
	if err == nil {
		notify(s.tool, s.doneNote)
	}
}

func (a *App) officeState() string { return office.State() }

// installOffice installs LibreOffice (free, about 350 MB).
func (a *App) installOffice() { office.Install() }
