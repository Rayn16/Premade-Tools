package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Friends' calls: /api/ui/friends/… for the PC window, /api/phone/friends/… for paired phones. Both act for the
// same person: the PC and its phones are one person in Friends.
func (a *App) friendsRoutes(m *http.ServeMux) {
	both := func(p string, h func(w http.ResponseWriter, r *http.Request, from string)) {
		meth := "POST "
		if p == "" {
			meth = "GET "
		}
		m.Handle(meth+"/api/ui/friends"+p, localOnly(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h(w, r, "pc") })))
		m.HandleFunc(meth+"/api/phone/friends"+p, a.tokenOnly(func(w http.ResponseWriter, r *http.Request, ph *Phone) { h(w, r, ph.ID) }))
	}
	ok := func(w http.ResponseWriter, err error) {
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		writeJ(w, "ok")
	}
	both("", func(w http.ResponseWriter, r *http.Request, from string) { writeJ(w, a.fr.State(from)) })
	both("/join", func(w http.ResponseWriter, r *http.Request, from string) {
		var in struct{ Name string }
		json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in)
		ok(w, a.fr.Join(in.Name))
	})
	both("/name", func(w http.ResponseWriter, r *http.Request, from string) {
		var in struct{ Name, PC string }
		json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in)
		a.set.With(func(c *Config) bool {
			if n := strings.TrimSpace(in.Name); n != "" {
				c.FrName = n
			}
			if n := strings.TrimSpace(in.PC); n != "" {
				c.FrPC = n
			}
			return true
		})
		a.fr.poke()
		writeJ(w, "ok")
	})
	both("/approve/{id}", func(w http.ResponseWriter, r *http.Request, from string) {
		ok(w, a.fr.Admin("approve", r.PathValue("id")))
	})
	both("/remove/{id}", func(w http.ResponseWriter, r *http.Request, from string) {
		ok(w, a.fr.Admin("remove", r.PathValue("id")))
	})
	// Share on a finished result: {tool: dl|cv|pdf|tr|drop, id, to, dev}.
	both("/send", func(w http.ResponseWriter, r *http.Request, from string) {
		var in struct{ Tool, ID, To, Dev string }
		json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in)
		ok(w, a.fr.Send(from, in.To, in.Dev, a.jobPaths(in.Tool, in.ID), false))
	})
	// Any other file: the page uploads it here, raw, with ?to=&dev=&name=, and the PC sends it on. A file that came
	// in pieces (piece) is named by ?piece= instead.
	both("/upload", func(w http.ResponseWriter, r *http.Request, from string) {
		q := r.URL.Query()
		name := cleanName(q.Get("name"), 0)
		dir, err := os.MkdirTemp(appDir(), "fsend-")
		if err != nil {
			ok(w, err)
			return
		}
		path := filepath.Join(dir, name)
		if q.Has("piece") {
			if err = takePieces(q.Get("piece"), dir, name); err != nil {
				err = fmt.Errorf("The file didn't arrive whole. Try again.")
			}
		} else if fh, cerr := os.Create(path); cerr != nil {
			err = cerr
		} else {
			_, err = io.Copy(fh, io.LimitReader(r.Body, 1<<30+1))
			fh.Close()
		}
		if err != nil {
			os.RemoveAll(dir)
			ok(w, err)
			return
		}
		if err = a.fr.Send(from, q.Get("to"), q.Get("dev"), []string{path}, true); err != nil {
			os.RemoveAll(dir)
		}
		ok(w, err)
	})
}
