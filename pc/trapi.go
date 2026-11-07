package main

import (
	"bufio"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Transcribe's calls: /api/ui/tr/… for the PC window and /api/phone/tr/… for paired phones. Start takes the files
// as "f" parts with ?to=text (as spoken) or ?to=en (translated into English). File 0 of a done job is the .txt,
// file 1 the .srt (then 2 and 3 for a second file, …).
func (a *App) trRoutes(m *http.ServeMux) {
	ui := func(p string, h http.HandlerFunc) { m.Handle(p, localOnly(h)) }
	ph := func(p string, h func(http.ResponseWriter, *http.Request, *Phone)) { m.HandleFunc(p, a.tokenOnly(h)) }

	ui("GET /api/ui/tr", func(w http.ResponseWriter, r *http.Request) { writeJ(w, a.trState("")) })
	ui("POST /api/ui/tr/start", func(w http.ResponseWriter, r *http.Request) { a.trStart(w, r, "") })
	ui("POST /api/ui/tr/fromdl/{id}", func(w http.ResponseWriter, r *http.Request) { a.trFromDL(w, r, "") })
	ui("POST /api/ui/tr/engine", func(w http.ResponseWriter, r *http.Request) {
		to := r.URL.Query().Get("to")
		if to != "en" {
			to = "text"
		}
		go whisper.Install(to, nil)
		writeJ(w, "ok")
	})
	a.queueRoutes(m, "tr", a.tr, func(c *Config, dir string) { c.TrDir = dir })

	ph("GET /api/phone/tr", func(w http.ResponseWriter, r *http.Request, p *Phone) { writeJ(w, a.trState(p.ID)) })
	ph("POST /api/phone/tr/start", func(w http.ResponseWriter, r *http.Request, p *Phone) { a.trStart(w, r, p.ID) })
	ph("POST /api/phone/tr/fromdl/{id}", func(w http.ResponseWriter, r *http.Request, p *Phone) { a.trFromDL(w, r, p.ID) })

	// The iPhone's "Transcribe with Premade" Shortcut (it records, or takes a shared voice memo). Step 1: send the
	// sound as the body (?name=…&to=text|en), get back a job id or "ERR: why".
	ph("POST /api/phone/tr/ios/start", func(w http.ResponseWriter, r *http.Request, p *Phone) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		name := cleanName(r.URL.Query().Get("name"), 0)
		if TrCheck([]string{name}) != "" {
			name += ".m4a" // ponytail: a shared voice memo can arrive without its extension; FFmpeg reads the real type anyway
		}
		id := newID()
		if err := saveBody(bufio.NewReader(r.Body), a.tr.InputDir(id), name); err != nil {
			os.RemoveAll(a.tr.InputDir(id))
			fmt.Fprint(w, "ERR: The sound didn't arrive whole. Try again.")
			return
		}
		j, why := a.tr.StartTr(id, []string{name}, r.URL.Query().Get("to"), p.ID)
		if j == nil {
			fmt.Fprint(w, "ERR: "+why)
			return
		}
		fmt.Fprint(w, j.ID)
	})
	// Step 2: poll: "WAIT 42" while it runs, then the text itself, or "ERR: why".
	ph("GET /api/phone/tr/ios/get/{id}", func(w http.ResponseWriter, r *http.Request, p *Phone) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		j := a.tr.Get(r.PathValue("id"))
		switch {
		case j == nil:
			fmt.Fprint(w, "ERR: That recording is gone from the PC.")
		case j.State == "failed":
			fmt.Fprint(w, "ERR: "+j.Note)
		case j.State != "done":
			fmt.Fprintf(w, "WAIT %d", int(j.Pct))
		default:
			fmt.Fprint(w, a.trText(j))
		}
	})
}

// trText is the words of a done job (each .txt, a blank line between files).
func (a *App) trText(j *CvJob) string {
	var parts []string
	for n, f := range j.Files {
		if p, ok := a.tr.Path(j, n); ok && strings.EqualFold(filepath.Ext(f.Name), ".txt") {
			if b, err := os.ReadFile(p); err == nil {
				parts = append(parts, strings.TrimSpace(string(b)))
			}
		}
	}
	if t := strings.Join(parts, "\n\n"); t != "" {
		return t
	}
	return "(No speech was heard.)"
}

func (a *App) trState(from string) map[string]any {
	dir := a.set.Get().TrOutDir()
	free, _ := diskSpace(dir)
	return map[string]any{"jobs": a.tr.Jobs(from), "engine": whisper.State(), "dir": dir, "free": human(int64(free))}
}

func (a *App) trStart(w http.ResponseWriter, r *http.Request, from string) {
	id := newID()
	names, _, err := recvUpload(r, a.tr.InputDir(id))
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	j, why := a.tr.StartTr(id, names, r.URL.Query().Get("to"), from)
	if j == nil {
		http.Error(w, why, 400)
		return
	}
	writeJ(w, j)
}

// trFromDL transcribes what a download saved, straight from the download folder (nothing is sent).
func (a *App) trFromDL(w http.ResponseWriter, r *http.Request, from string) {
	d := a.dl.Get(r.PathValue("id"))
	if d == nil || d.State != "done" {
		http.Error(w, "That download is gone from the PC.", 404)
		return
	}
	id := newID()
	dir := a.tr.InputDir(id)
	var names []string
	for n, f := range d.Files {
		src, ok := a.dl.Path(d, n)
		if !ok || TrCheck([]string{f.Name}) != "" {
			continue
		}
		name := filepath.Base(src)
		os.MkdirAll(dir, 0o755)
		if os.Link(src, filepath.Join(dir, name)) != nil && copyFile(src, filepath.Join(dir, name)) != nil {
			continue
		}
		names = append(names, name)
	}
	if len(names) == 0 {
		os.RemoveAll(dir)
		http.Error(w, "That download has no video or sound to transcribe.", 400)
		return
	}
	j, why := a.tr.StartTr(id, names, r.URL.Query().Get("to"), from)
	if j == nil {
		http.Error(w, why, 400)
		return
	}
	writeJ(w, j)
}
