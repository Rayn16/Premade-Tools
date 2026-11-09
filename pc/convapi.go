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
	"regexp"
	"strconv"
	"strings"
	"time"
)

// The Converter's calls: /api/ui/cv/… for the PC window, /api/phone/cv/… for paired phones, and plain-text
// /api/phone/cv/ios/… for the iPhone's "Convert with Premade" Shortcut.
func (a *App) cvRoutes(m *http.ServeMux) {
	ui := func(p string, h http.HandlerFunc) { m.Handle(p, localOnly(h)) }
	ph := func(p string, h func(http.ResponseWriter, *http.Request, *Phone)) { m.HandleFunc(p, a.tokenOnly(h)) }

	ui("GET /api/ui/cv", func(w http.ResponseWriter, r *http.Request) { writeJ(w, a.cvState("")) })
	ui("POST /api/ui/cv/start", func(w http.ResponseWriter, r *http.Request) { a.cvStart(w, r, "") })
	a.queueRoutes(m, "cv", a.cv, func(c *Config, dir string) { c.DlDir = dir })
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
	free, _ := diskSpace(c.DownloadDir())
	ready := map[string]bool{}
	for _, e := range []string{"magick", "ffmpeg", "soffice"} {
		ready[e] = a.cvBin(e) != ""
	}
	return map[string]any{"jobs": a.cv.Jobs(from), "kinds": Kinds, "ready": ready, "dir": c.DownloadDir(), "free": human(int64(free)),
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
		var file string
		if part.FileName() == "" {
			max := int64(4 << 10)
			if part.FormName() == "text" {
				max = 256 << 10 // File drop's text, as long as the clipboard takes
			}
			b, _ := io.ReadAll(io.LimitReader(part, max+1))
			if int64(len(b)) > max {
				os.RemoveAll(dir)
				return nil, nil, fmt.Errorf("That text is too long to send. Save it in a file and send the file.")
			}
			if part.FormName() != "p" {
				fields[part.FormName()] = string(b)
				continue
			}
			file = string(b) // a file that came in pieces, as "<id>/<name>"
		} else if part.FormName() != "f" {
			continue
		}
		u, sent, _ := strings.Cut(file, "/")
		if file == "" {
			sent = part.FileName()
		}
		name := cleanName(sent, len(names))
		for _, n := range names { // two files with one name
			if strings.EqualFold(n, name) {
				name = fmt.Sprintf("%s (%d)%s", baseName(name), len(names)+1, filepath.Ext(name))
			}
		}
		if file != "" {
			err = takePieces(u, dir, name)
		} else {
			err = saveBody(part, dir, name)
		}
		if err != nil {
			os.RemoveAll(dir)
			return nil, nil, fmt.Errorf("The files didn't arrive whole. Try again.")
		}
		names = append(names, name)
	}
	return names, fields, nil
}

// Phones away from home reach the PC through the relay's link (the iPhone app always does), and the relay takes
// nothing over 100 MB in one call. So a bigger file comes first in pieces, PUT /api/phone/piece?u=<id>&at=<offset>
// in order, and the upload then names it: a "p" field "<id>/<name>" in place of the file, or ?piece=<id> for Friends.
var pieceID = regexp.MustCompile(`^[0-9a-f]{32}$`)

func piecePath(u string) string {
	if !pieceID.MatchString(u) {
		return ""
	}
	return filepath.Join(appDir(), "pieces", u)
}

func (a *App) piece(w http.ResponseWriter, r *http.Request, p *Phone) {
	q := r.URL.Query()
	path := piecePath(q.Get("u"))
	at, err := strconv.ParseInt(q.Get("at"), 10, 64)
	if path == "" || err != nil || at < 0 || at > 20<<30 {
		http.Error(w, "bad request", 400)
		return
	}
	if at == 0 { // a new file: pieces of one given up on more than a day ago go
		es, _ := os.ReadDir(filepath.Dir(path))
		for _, e := range es {
			if fi, err := e.Info(); err == nil && time.Since(fi.ModTime()) > 24*time.Hour {
				os.Remove(filepath.Join(filepath.Dir(path), e.Name()))
			}
		}
	}
	os.MkdirAll(filepath.Dir(path), 0o755)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		http.Error(w, "The PC couldn't keep that file. Try again.", 500)
		return
	}
	n := int64(0)
	if fi, serr := f.Stat(); serr != nil || at > fi.Size() {
		err = fmt.Errorf("a piece is missing")
	} else if _, err = f.Seek(at, io.SeekStart); err == nil { // a piece sent again writes over what came of it before
		n, err = io.Copy(f, io.LimitReader(r.Body, 100<<20+1))
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil || n > 100<<20 {
		http.Error(w, "The file didn't arrive whole. Try again.", 400)
		return
	}
	writeJ(w, "ok")
}

// takePieces moves a file that came in pieces into dir.
func takePieces(u, dir, name string) error {
	src := piecePath(u)
	if src == "" {
		return fmt.Errorf("bad piece id")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.Rename(src, filepath.Join(dir, name))
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
	if b, _, _ := strings.Cut(s, "."); winDevice.MatchString(strings.TrimRight(b, " ")) {
		s = "_" + s
	}
	return s
}

// winDevice matches the names Windows opens a device for instead of a file (CON, NUL, COM1, …), extension or not.
var winDevice = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$`)

// psQuote makes s one single-quoted PowerShell string. PowerShell takes ‘ ’ ‚ ‛ as quote marks too, so each of the
// five is doubled, as PowerShell's own CodeGeneration.EscapeSingleQuotedStringContent does.
func psQuote(s string) string { return "'" + psQuotes.Replace(s) + "'" }

var psQuotes = strings.NewReplacer("'", "''", "‘", "‘‘", "’", "’’", "‚", "‚‚", "‛", "‛‛")

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
