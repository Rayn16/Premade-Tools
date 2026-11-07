package main

import (
	"archive/zip"
	"bufio"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// The Converter's calls: /api/ui/cv/… for the PC window, /api/phone/cv/… for paired phones, and plain-text
// /api/phone/cv/ios/… for the iPhone's "Convert with Premade" Shortcut.
func (a *App) cvRoutes(m *http.ServeMux) {
	ui := func(p string, h http.HandlerFunc) { m.Handle(p, localOnly(h)) }
	ph := func(p string, h func(http.ResponseWriter, *http.Request, *Phone)) { m.HandleFunc(p, a.tokenOnly(h)) }

	ui("GET /api/ui/cv", func(w http.ResponseWriter, r *http.Request) { writeJ(w, a.cvState("")) })
	ui("POST /api/ui/cv/start", func(w http.ResponseWriter, r *http.Request) { a.cvStart(w, r, "") })
	a.queueRoutes(m, "cv", a.cv, func(c *Config, dir string) { c.CvDir = dir })
	ui("POST /api/ui/cv/office", func(w http.ResponseWriter, r *http.Request) { go a.installOffice(); writeJ(w, "ok") })

	ph("GET /api/phone/cv", func(w http.ResponseWriter, r *http.Request, p *Phone) { writeJ(w, a.cvState(p.ID)) })
	ph("POST /api/phone/cv/start", func(w http.ResponseWriter, r *http.Request, p *Phone) { a.cvStart(w, r, p.ID) })

	// The Shortcut, step 1: what can this file become? One choice per line, or "ERR: why".
	ph("GET /api/phone/cv/ios/targets", func(w http.ResponseWriter, r *http.Request, p *Phone) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		name := r.URL.Query().Get("name")
		k := KindOf(name)
		if k == nil && filepath.Ext(name) == "" {
			k = &Kinds[0] // ponytail: no extension came through; the Share sheet's usual case is a photo, start checks the real type
		}
		if k == nil {
			_, why := a.cv.Check([]string{r.URL.Query().Get("name")}, "", false)
			fmt.Fprint(w, "ERR: "+why)
			return
		}
		var lines []string
		for _, t := range k.Targets {
			lines = append(lines, t.Label)
		}
		fmt.Fprint(w, strings.Join(lines, "\n"))
	})
	// Step 2: send the file as the body (?name=…&to=<a choice from step 1>), get back a job id or "ERR: why".
	ph("POST /api/phone/cv/ios/start", func(w http.ResponseWriter, r *http.Request, p *Phone) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		q := r.URL.Query()
		name := cleanName(q.Get("name"), 0)
		body := bufio.NewReader(r.Body)
		if KindOf(name) == nil { // a photo shared without its extension: tell from the first bytes
			head, _ := body.Peek(12)
			name += sniffExt(head)
		}
		k := KindOf(name)
		if k == nil {
			_, why := a.cv.Check([]string{name}, "", false)
			fmt.Fprint(w, "ERR: "+why)
			return
		}
		id := newID()
		dir := a.cv.InputDir(id)
		if err := saveBody(body, dir, name); err != nil {
			os.RemoveAll(dir)
			fmt.Fprint(w, "ERR: The file didn't arrive whole. Try again.")
			return
		}
		j, why := a.cv.Start(id, []string{name}, targetID(k, q.Get("to")), q.Get("small") == "1", false, p.ID)
		if j == nil {
			fmt.Fprint(w, "ERR: "+why)
			return
		}
		fmt.Fprint(w, j.ID)
	})
	// Step 3: poll until it's ready: "WAIT 42" while it runs, then the file, or "ERR: why".
	ph("GET /api/phone/cv/ios/get/{id}", func(w http.ResponseWriter, r *http.Request, p *Phone) {
		j := a.cv.Get(r.PathValue("id"))
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		switch {
		case j == nil:
			fmt.Fprint(w, "ERR: That conversion is gone from the PC.")
		case j.State == "failed":
			fmt.Fprint(w, "ERR: "+j.Note)
		case j.State != "done":
			fmt.Fprintf(w, "WAIT %d", int(j.Pct))
		case len(j.Files) == 1:
			a.cv.update(j.ID, func(j *CvJob) { j.Fetched = true })
			a.queueFile(w, r, a.cv, true)
		default:
			a.cv.update(j.ID, func(j *CvJob) { j.Fetched = true })
			queueZip(w, a.cv, j, "converted-")
		}
	})
}

// targetID takes a choice as the Shortcut shows it ("Word") or as an id ("docx").
func targetID(k *Kind, s string) string {
	for _, t := range k.Targets {
		if strings.EqualFold(s, t.ID) || strings.EqualFold(s, t.Label) {
			return t.ID
		}
	}
	return strings.ToLower(s)
}

func (a *App) cvState(from string) map[string]any {
	c := a.set.Get()
	free, _ := diskSpace(c.ConvertDir())
	ready := map[string]bool{}
	for _, e := range []string{"magick", "ffmpeg", "soffice"} {
		ready[e] = a.cvBin(e) != ""
	}
	return map[string]any{"jobs": a.cv.Jobs(from), "kinds": Kinds, "ready": ready, "dir": c.ConvertDir(), "free": human(int64(free)),
		"office": a.officeState()}
}

// cvStart takes a multipart upload of files ("f") with ?to=jpg&small=1&combine=1 and queues the job.
func (a *App) cvStart(w http.ResponseWriter, r *http.Request, from string) {
	q := r.URL.Query()
	id := newID()
	names, _, err := recvUpload(r, a.cv.InputDir(id))
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	j, why := a.cv.Start(id, names, strings.ToLower(q.Get("to")), q.Get("small") == "1", q.Get("combine") == "1", from)
	if j == nil {
		http.Error(w, why, 400)
		return
	}
	writeJ(w, j)
}

// recvUpload saves a multipart upload's files ("f") into dir, in the order sent, and returns their names and
// the other (small) fields.
func recvUpload(r *http.Request, dir string) ([]string, map[string]string, error) {
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, nil, fmt.Errorf("bad request")
	}
	var names []string
	fields := map[string]string{}
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			os.RemoveAll(dir)
			return nil, nil, fmt.Errorf("The files didn't arrive whole. Try again.")
		}
		if part.FileName() == "" {
			b, _ := io.ReadAll(io.LimitReader(part, 4<<10))
			fields[part.FormName()] = string(b)
			continue
		}
		if part.FormName() != "f" {
			continue
		}
		name := cleanName(part.FileName(), len(names))
		for _, n := range names { // two files with one name
			if strings.EqualFold(n, name) {
				name = fmt.Sprintf("%s (%d)%s", baseName(name), len(names)+1, filepath.Ext(name))
			}
		}
		if err := saveBody(part, dir, name); err != nil {
			os.RemoveAll(dir)
			return nil, nil, fmt.Errorf("The files didn't arrive whole. Try again.")
		}
		names = append(names, name)
	}
	return names, fields, nil
}

// cleanName keeps a sent file name safe to use on disk.
func cleanName(s string, n int) string {
	s = filepath.Base(strings.ReplaceAll(s, "\\", "/"))
	s = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, s)
	s = strings.Trim(s, ". ")
	if s == "" || s == "_" {
		s = "file" + strconv.Itoa(n+1)
	}
	return s
}

func saveBody(r io.Reader, dir, name string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f, err := os.Create(filepath.Join(dir, name))
	if err != nil {
		return err
	}
	_, err = io.Copy(f, io.LimitReader(r, 20<<30))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// queueRoutes adds the calls every job tool has, under /api/ui/<p>/… and /api/phone/<p>/….
func (a *App) queueRoutes(m *http.ServeMux, p string, q *Converter, setDir func(c *Config, dir string)) {
	ui := func(path string, h http.HandlerFunc) { m.Handle(path, localOnly(h)) }
	ph := func(path string, h func(http.ResponseWriter, *http.Request, *Phone)) {
		m.HandleFunc(path, a.tokenOnly(h))
	}
	ui("POST /api/ui/"+p+"/cancel/{id}", func(w http.ResponseWriter, r *http.Request) { q.Cancel(r.PathValue("id")); writeJ(w, "ok") })
	ui("POST /api/ui/"+p+"/remove/{id}", func(w http.ResponseWriter, r *http.Request) { q.Remove(r.PathValue("id")); writeJ(w, "ok") })
	ui("POST /api/ui/"+p+"/show/{id}", func(w http.ResponseWriter, r *http.Request) {
		if j := q.Get(r.PathValue("id")); j != nil {
			if path, ok := q.Path(j, 0); ok {
				showInFolder(path)
			}
		}
		writeJ(w, "ok")
	})
	ui("GET /api/ui/"+p+"/file/{id}/{n}", func(w http.ResponseWriter, r *http.Request) { a.queueFile(w, r, q, false) })
	ui("POST /api/ui/"+p+"/folder", func(w http.ResponseWriter, r *http.Request) {
		if dir := pickFolder(); dir != "" {
			a.set.With(func(c *Config) bool { setDir(c, dir); return true })
		}
		writeJ(w, map[string]string{"dir": q.dir()})
	})

	mine := func(r *http.Request, ph *Phone) *CvJob {
		if j := q.Get(r.PathValue("id")); j != nil && j.From == ph.ID {
			return j
		}
		return nil
	}
	ph("POST /api/phone/"+p+"/cancel/{id}", func(w http.ResponseWriter, r *http.Request, p *Phone) {
		if j := mine(r, p); j != nil {
			q.Cancel(j.ID)
		}
		writeJ(w, "ok")
	})
	ph("POST /api/phone/"+p+"/remove/{id}", func(w http.ResponseWriter, r *http.Request, p *Phone) {
		if j := mine(r, p); j != nil {
			q.Remove(j.ID)
		}
		writeJ(w, "ok")
	})
	ph("GET /api/phone/"+p+"/file/{id}/{n}", func(w http.ResponseWriter, r *http.Request, p *Phone) { a.queueFile(w, r, q, false) })
	ph("POST /api/phone/"+p+"/fetched/{id}", func(w http.ResponseWriter, r *http.Request, p *Phone) {
		q.update(r.PathValue("id"), func(j *CvJob) {
			if j.From == p.ID {
				j.Fetched = true
			}
		})
		writeJ(w, "ok")
	})
}

// queueFile serves result n of a job, as a download when attach is set or ?dl is given.
func (a *App) queueFile(w http.ResponseWriter, r *http.Request, q *Converter, attach bool) {
	j := q.Get(r.PathValue("id"))
	n, _ := strconv.Atoi(r.PathValue("n"))
	if j == nil {
		http.NotFound(w, r)
		return
	}
	path, ok := q.Path(j, n)
	if !ok {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		http.Error(w, "The file is gone from the converted folder.", 404)
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

func queueZip(w http.ResponseWriter, q *Converter, j *CvJob, prefix string) {
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": prefix + j.ID + ".zip"}))
	zw := zip.NewWriter(w)
	for i := range j.Files {
		p, ok := q.Path(j, i)
		if !ok {
			continue
		}
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		if hw, err := zw.CreateHeader(&zip.FileHeader{Name: filepath.Base(p), Method: zip.Store}); err == nil {
			io.Copy(hw, f)
		}
		f.Close()
	}
	zw.Close()
}
