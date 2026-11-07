package main

import (
	"net/http"
	"os"
	"path/filepath"
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
