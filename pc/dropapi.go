package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"
)

// File drop's calls: /api/ui/drop/… for the PC window, /api/phone/drop/… for paired phones. Send takes files as
// "f" parts and/or a "text" field, with ?to=pc or a phone id.
func (a *App) dropRoutes(m *http.ServeMux) {
	ui := func(p string, h http.HandlerFunc) { m.Handle(p, localOnly(h)) }
	ph := func(p string, h func(http.ResponseWriter, *http.Request, *Phone)) { m.HandleFunc(p, a.tokenOnly(h)) }

	ui("GET /api/ui/drop", func(w http.ResponseWriter, r *http.Request) { writeJ(w, a.dropState("pc", "")) })
	ui("POST /api/ui/drop/send", func(w http.ResponseWriter, r *http.Request) { a.dropSend(w, r, "pc") })
	ui("POST /api/ui/drop/remove/{id}", func(w http.ResponseWriter, r *http.Request) { a.drops.Remove(r.PathValue("id")); writeJ(w, "ok") })
	ui("GET /api/ui/drop/file/{id}/{n}", func(w http.ResponseWriter, r *http.Request) { a.dropFile(w, r, "") })
	ui("POST /api/ui/drop/show/{id}", func(w http.ResponseWriter, r *http.Request) {
		if it := a.drops.Get(r.PathValue("id")); it != nil {
			if p, ok := a.drops.Path(it, 0); ok {
				showInFolder(p)
			}
		}
		writeJ(w, "ok")
	})
	ui("POST /api/ui/drop/open/{id}", func(w http.ResponseWriter, r *http.Request) {
		if it := a.drops.Get(r.PathValue("id")); it != nil && it.Kind == "link" && isLink(it.Text) {
			openURL(it.Text)
		}
		writeJ(w, "ok")
	})
	ui("POST /api/ui/drop/copy/{id}", func(w http.ResponseWriter, r *http.Request) {
		if it := a.drops.Get(r.PathValue("id")); it != nil && it.Text != "" {
			a.putClip(it.From, it.Text)
			clipSet(it.Text) // even with sync off
		}
		writeJ(w, "ok")
	})
	ui("POST /api/ui/drop/folder", func(w http.ResponseWriter, r *http.Request) {
		if dir := pickFolder(); dir != "" {
			a.set.With(func(c *Config) bool { c.DlDir = dir; return true })
		}
		writeJ(w, map[string]string{"dir": a.set.Get().DownloadDir()})
	})

	ph("GET /api/phone/drop", func(w http.ResponseWriter, r *http.Request, p *Phone) { writeJ(w, a.dropState(p.ID, p.ID)) })
	ph("POST /api/phone/drop/send", func(w http.ResponseWriter, r *http.Request, p *Phone) { a.dropSend(w, r, p.ID) })
	ph("GET /api/phone/drop/file/{id}/{n}", func(w http.ResponseWriter, r *http.Request, p *Phone) { a.dropFile(w, r, p.ID) })
	ph("POST /api/phone/drop/fetched/{id}", func(w http.ResponseWriter, r *http.Request, p *Phone) {
		a.drops.update(r.PathValue("id"), func(it *Drop) {
			if it.To == p.ID {
				it.Fetched, it.Seen = true, true
			}
		})
		writeJ(w, "ok")
	})
	ph("POST /api/phone/drop/seen/{id}", func(w http.ResponseWriter, r *http.Request, p *Phone) {
		a.drops.update(r.PathValue("id"), func(it *Drop) {
			if it.To == p.ID {
				it.Seen = true
			}
		})
		writeJ(w, "ok")
	})
	ph("POST /api/phone/drop/remove/{id}", func(w http.ResponseWriter, r *http.Request, p *Phone) {
		if it := a.drops.Get(r.PathValue("id")); it != nil && (it.To == p.ID || it.From == p.ID) {
			a.drops.Remove(it.ID)
		}
		writeJ(w, "ok")
	})
	// A phone's copy: {"text": …}. Ignored while clipboard sync is off.
	ph("POST /api/phone/drop/clip", func(w http.ResponseWriter, r *http.Request, p *Phone) {
		var in struct{ Text string }
		json.NewDecoder(io.LimitReader(r.Body, 300<<10)).Decode(&in)
		if a.set.Get().ClipSync {
			a.putClip(p.ID, in.Text)
		}
		writeJ(w, a.drops.Clip())
	})
	// The iPhone's "Drop to PC" Shortcut sends each item as the body (?to=pc|phone id&name=…). A name without an
	// extension and a short body of plain text means copied text or a link; anything else is a file.
	// Replies "OK: what happened" or "ERR: why".
	ph("POST /api/phone/drop/ios", func(w http.ResponseWriter, r *http.Request, p *Phone) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		to := a.dropTo(r.URL.Query().Get("to"), p.ID)
		if to == "" {
			fmt.Fprint(w, "ERR: That device isn't paired with the PC any more.")
			return
		}
		body := bufio.NewReaderSize(r.Body, 64<<10)
		name := r.URL.Query().Get("name")
		head, _ := body.Peek(64 << 10)
		var it *Drop
		var err error
		if filepath.Ext(name) == "" && len(head) < 64<<10 && utf8.Valid(head) && !strings.ContainsRune(string(head), 0) {
			it, err = a.drops.Add(p.ID, to, string(head), "", nil)
		} else {
			name = cleanName(name, 0)
			if filepath.Ext(name) == "" {
				name += sniffExt(head)
			}
			tmp := filepath.Join(a.drops.hold, "in-"+newID())
			if err = saveBody(body, tmp, name); err != nil {
				os.RemoveAll(tmp)
				fmt.Fprint(w, "ERR: It didn't arrive whole. Try again.")
				return
			}
			it, err = a.drops.Add(p.ID, to, "", tmp, []string{name})
		}
		if err != nil {
			fmt.Fprint(w, "ERR: "+err.Error())
			return
		}
		a.dropArrived(it)
		fmt.Fprint(w, "OK: Sent to "+a.devName(to)+".")
	})
}

// dropTo checks a destination: "pc" or a paired phone other than the sender. "" when it's neither.
func (a *App) dropTo(to, from string) string {
	if to == "" {
		to = "pc"
	}
	for _, d := range a.dropDevices() {
		if d.ID == to && to != from {
			return to
		}
	}
	return ""
}

func (a *App) dropState(me, who string) map[string]any {
	c := a.set.Get()
	return map[string]any{"me": me, "devices": a.dropDevices(), "jobs": a.drops.List(who), "clip": a.drops.Clip(),
		"clipSync": c.ClipSync, "dir": c.DownloadDir()}
}

func (a *App) dropSend(w http.ResponseWriter, r *http.Request, from string) {
	to := a.dropTo(r.URL.Query().Get("to"), from)
	if to == "" {
		http.Error(w, "Pick another device to send to.", 400)
		return
	}
	tmp := filepath.Join(a.drops.hold, "in-"+newID())
	names, fields, err := recvUpload(r, tmp)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	it, err := a.drops.Add(from, to, fields["text"], tmp, names)
	if err != nil {
		os.RemoveAll(tmp)
		http.Error(w, err.Error(), 400)
		return
	}
	a.dropArrived(it)
	writeJ(w, it)
}

// dropFile serves file n of a drop; a phone only gets drops to or from itself.
func (a *App) dropFile(w http.ResponseWriter, r *http.Request, who string) {
	it := a.drops.Get(r.PathValue("id"))
	n, _ := strconv.Atoi(r.PathValue("n"))
	if it == nil || (who != "" && it.To != who && it.From != who) {
		http.NotFound(w, r)
		return
	}
	p, ok := a.drops.Path(it, n)
	if !ok {
		http.Error(w, "That file is gone from the PC.", 404)
		return
	}
	f, err := os.Open(p)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer f.Close()
	if ct := mime.TypeByExtension(filepath.Ext(p)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	disp := "inline"
	if r.URL.Query().Has("dl") {
		disp = "attachment"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disp, map[string]string{"filename": it.Files[n].Name}))
	http.ServeContent(w, r, "", it.At, f)
}
