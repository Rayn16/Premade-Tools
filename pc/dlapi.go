package main

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// The Downloader's calls: /api/ui/dl/… for the PC window, /api/phone/dl/… for paired phones, and plain-text
// /api/phone/dl/ios/… for the iPhone's "Download with Premade" Shortcut.
func (a *App) dlRoutes(m *http.ServeMux) {
	ui := func(p string, h http.HandlerFunc) { m.Handle(p, localOnly(h)) }
	ph := func(p string, h func(http.ResponseWriter, *http.Request, *Phone)) { m.HandleFunc(p, a.tokenOnly(h)) }

	ui("GET /api/ui/dl", func(w http.ResponseWriter, r *http.Request) { writeJ(w, a.dlState()) })
	ui("GET /api/ui/dl/probe", func(w http.ResponseWriter, r *http.Request) { a.dlProbe(w, r) })
	ui("POST /api/ui/dl/start", func(w http.ResponseWriter, r *http.Request) { a.dlStart(w, r, "") })
	ui("POST /api/ui/dl/cancel/{id}", func(w http.ResponseWriter, r *http.Request) { a.dl.Cancel(r.PathValue("id")); writeJ(w, "ok") })
	ui("POST /api/ui/dl/remove/{id}", func(w http.ResponseWriter, r *http.Request) { a.dl.Remove(r.PathValue("id")); writeJ(w, "ok") })
	ui("POST /api/ui/dl/show/{id}", func(w http.ResponseWriter, r *http.Request) {
		if j := a.dl.Get(r.PathValue("id")); j != nil {
			if p, ok := a.dl.Path(j, 0); ok {
				showInFolder(p)
			}
		}
		writeJ(w, "ok")
	})
	ui("GET /api/ui/dl/file/{id}/{n}", func(w http.ResponseWriter, r *http.Request) { a.dlFile(w, r, false) })
	ui("POST /api/ui/dl/folder", func(w http.ResponseWriter, r *http.Request) {
		dir := pickFolder()
		if dir != "" {
			a.set.With(func(c *Config) bool { c.DlDir = dir; return true })
		}
		writeJ(w, map[string]string{"dir": a.set.Get().DownloadDir()})
	})
	ui("POST /api/ui/dl/nightly", func(w http.ResponseWriter, r *http.Request) {
		var in struct{ On bool }
		json.NewDecoder(r.Body).Decode(&in)
		a.set.With(func(c *Config) bool { c.DlNightly = in.On; return true })
		go a.eng.Update(true)
		writeJ(w, "ok")
	})
	ui("POST /api/ui/dl/engines", func(w http.ResponseWriter, r *http.Request) { go a.eng.Update(true); writeJ(w, "ok") })
	ui("POST /api/ui/dl/login/{site}", func(w http.ResponseWriter, r *http.Request) {
		if err := a.dl.OpenLogin(r.PathValue("site")); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		writeJ(w, "ok")
	})
	ui("POST /api/ui/dl/forget-logins", func(w http.ResponseWriter, r *http.Request) { a.dl.ForgetLogins(); writeJ(w, "ok") })

	ph("GET /api/phone/dl", func(w http.ResponseWriter, r *http.Request, p *Phone) { writeJ(w, a.dlState()) })
	ph("GET /api/phone/dl/probe", func(w http.ResponseWriter, r *http.Request, p *Phone) { a.dlProbe(w, r) })
	ph("POST /api/phone/dl/start", func(w http.ResponseWriter, r *http.Request, p *Phone) { a.dlStart(w, r, p.ID) })
	ph("POST /api/phone/dl/cancel/{id}", func(w http.ResponseWriter, r *http.Request, p *Phone) {
		if j := a.dl.Get(r.PathValue("id")); j != nil && j.From == p.ID {
			a.dl.Cancel(j.ID)
		}
		writeJ(w, "ok")
	})
	ph("GET /api/phone/dl/file/{id}/{n}", func(w http.ResponseWriter, r *http.Request, p *Phone) { a.dlFile(w, r, false) })
	ph("POST /api/phone/dl/fetched/{id}", func(w http.ResponseWriter, r *http.Request, p *Phone) {
		a.dl.update(r.PathValue("id"), func(j *Job) {
			if j.From == p.ID {
				j.Fetched = true
			}
		})
		writeJ(w, "ok")
	})

	// The Shortcut: send the shared link as the body, get back a job id (or "ERR: why").
	ph("POST /api/phone/dl/ios/start", func(w http.ResponseWriter, r *http.Request, p *Phone) {
		b, _ := io.ReadAll(io.LimitReader(r.Body, 64<<10))
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		u := cleanURL(string(b))
		if u == "" {
			fmt.Fprint(w, "ERR: The Shortcut didn't get a link. Share a post or video, or copy its link first.")
			return
		}
		pr := a.dl.Probe(u)
		if pr.Err != "" {
			fmt.Fprint(w, "ERR: "+pr.Err)
			return
		}
		mode := ""
		if pr.Ask {
			mode = "one" // from the Share menu, a playlist link means the video it was shared from
		}
		j, pr, rep := a.dl.Start(string(b), r.URL.Query().Get("audio") == "1", mode, false, p.ID)
		switch {
		case rep != nil: // already downloaded: hand it over again
			fmt.Fprint(w, rep.ID)
		case j != nil:
			fmt.Fprint(w, j.ID)
		default:
			fmt.Fprint(w, "ERR: "+pr.Err)
		}
	})
	// Poll until it's ready: "WAIT 42" while it runs, then the file (several come as one zip), or "ERR: why".
	ph("GET /api/phone/dl/ios/get/{id}", func(w http.ResponseWriter, r *http.Request, p *Phone) {
		j := a.dl.Get(r.PathValue("id"))
		for i := 0; i < 40 && j != nil && (j.State == "queued" || j.State == "running"); i++ { // wait up to 20 s, so the Shortcut asks less often
			select {
			case <-r.Context().Done():
				return
			case <-time.After(500 * time.Millisecond):
			}
			j = a.dl.Get(j.ID)
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		switch {
		case j == nil:
			fmt.Fprint(w, "ERR: That download is gone from the PC.")
		case j.State == "failed":
			fmt.Fprint(w, "ERR: "+j.Note)
		case j.State != "done":
			fmt.Fprintf(w, "WAIT %d", int(j.Pct))
		case len(j.Files) == 1:
			a.dl.update(j.ID, func(j *Job) { j.Fetched = true })
			a.dlFile(w, r, true)
		default:
			a.dl.update(j.ID, func(j *Job) { j.Fetched = true })
			a.dlZip(w, j)
		}
	})
}

// tokenOnly lets a paired phone in. Unlike Vault's calls it doesn't need the vault folder.
func (a *App) tokenOnly(h func(http.ResponseWriter, *http.Request, *Phone)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if tok == "" {
			tok = r.URL.Query().Get("t")
		}
		for _, q := range a.set.Get().Phones {
			if tok != "" && q.Token == tok {
				h(w, r, q)
				return
			}
		}
		http.Error(w, "not paired", 401)
	}
}

func (a *App) dlState() map[string]any {
	c := a.set.Get()
	os.MkdirAll(c.DownloadDir(), 0o755)
	free, _ := diskSpace(c.DownloadDir())
	return map[string]any{"jobs": a.dl.Jobs(""), "engines": a.eng.List(), "ready": a.eng.Ready(), "dir": c.DownloadDir(),
		"free": human(int64(free)), "nightly": c.DlNightly, "logins": a.dl.LoggedIn()}
}

func (a *App) dlProbe(w http.ResponseWriter, r *http.Request) {
	u := cleanURL(r.URL.Query().Get("url"))
	if u == "" {
		writeJ(w, Probe{Err: "That doesn't look like a link. Copy the link from the app's Share button and paste it here."})
		return
	}
	writeJ(w, a.dl.Probe(u))
}

func (a *App) dlStart(w http.ResponseWriter, r *http.Request, from string) {
	var in struct {
		URL   string `json:"url"`
		Audio bool   `json:"audio"`
		Mode  string `json:"mode"`
		Force bool   `json:"force"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&in) != nil {
		http.Error(w, "bad request", 400)
		return
	}
	if in.Mode != "one" && in.Mode != "all" {
		in.Mode = ""
	}
	j, p, rep := a.dl.Start(in.URL, in.Audio, in.Mode, in.Force, from)
	writeJ(w, map[string]any{"job": j, "probe": p, "repeat": rep})
}

// dlFile serves file n of a job, as a download when attach is set or ?dl is given.
func (a *App) dlFile(w http.ResponseWriter, r *http.Request, attach bool) {
	j := a.dl.Get(r.PathValue("id"))
	n, _ := strconv.Atoi(r.PathValue("n"))
	if j == nil {
		http.NotFound(w, r)
		return
	}
	path, ok := a.dl.Path(j, n)
	if !ok {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		http.Error(w, "The file is gone from the download folder.", 404)
		return
	}
	defer f.Close()
	fi, _ := f.Stat()
	name := filepath.Base(path)
	if ct := mime.TypeByExtension(filepath.Ext(name)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	disp := "inline"
	if r.URL.Query().Has("dl") || attach {
		disp = "attachment"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disp, map[string]string{"filename": name}))
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

// dlZip sends all of a job's files as one zip (the Shortcut unzips it and saves each to Photos).
func (a *App) dlZip(w http.ResponseWriter, j *Job) {
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": "premade-" + j.ID + ".zip"}))
	zw := zip.NewWriter(w)
	for i := range j.Files {
		p, ok := a.dl.Path(j, i)
		if !ok {
			continue
		}
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		hw, err := zw.CreateHeader(&zip.FileHeader{Name: filepath.Base(p), Method: zip.Store})
		if err == nil {
			io.Copy(hw, f)
		}
		f.Close()
	}
	zw.Close()
}
