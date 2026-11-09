package main

import (
	"mime"
	"net/http"
	"strings"
)

// PDF.js comes as .mjs modules; browsers refuse them unless they're served as JavaScript.
func init() { mime.AddExtensionType(".mjs", "text/javascript; charset=utf-8") }

// The PDF tools' calls: /api/ui/pdf/… for the PC window and /api/phone/pdf/… for paired phones.
// Start takes the PDFs as "f" parts (in order), with ?op=edit|merge|pages|extract|split|compress|lock|unlock,
// &pages=3,1r90,2 for pages and extract, &level=smallest for compress, and the password as a "pw" field.
func (a *App) pdfRoutes(m *http.ServeMux) {
	ui := func(p string, h http.HandlerFunc) { m.Handle(p, localOnly(h)) }
	ph := func(p string, h func(http.ResponseWriter, *http.Request, *Phone)) { m.HandleFunc(p, a.tokenOnly(h)) }

	ui("GET /api/ui/pdf", func(w http.ResponseWriter, r *http.Request) { writeJ(w, a.pdfState("")) })
	ui("POST /api/ui/pdf/start", func(w http.ResponseWriter, r *http.Request) { a.pdfStart(w, r, "") })
	ui("POST /api/ui/pdf/gs", func(w http.ResponseWriter, r *http.Request) { go gs.Install(); writeJ(w, "ok") })
	a.queueRoutes(m, "pdf", a.pdf, func(c *Config, dir string) { c.DlDir = dir })

	ph("GET /api/phone/pdf", func(w http.ResponseWriter, r *http.Request, p *Phone) { writeJ(w, a.pdfState(p.ID)) })
	ph("POST /api/phone/pdf/start", func(w http.ResponseWriter, r *http.Request, p *Phone) { a.pdfStart(w, r, p.ID) })
}

func (a *App) pdfState(from string) map[string]any {
	dir := a.set.Get().DownloadDir()
	free, _ := diskSpace(dir)
	return map[string]any{"jobs": a.pdf.Jobs(from), "ops": PdfOps, "gs": gs.State(), "dir": dir, "free": human(int64(free))}
}

func (a *App) pdfStart(w http.ResponseWriter, r *http.Request, from string) {
	q := r.URL.Query()
	id := newID()
	names, fields, err := recvUpload(r, a.pdf.InputDir(id))
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	j, why := a.pdf.StartPdf(id, names, strings.ToLower(q.Get("op")), q.Get("pages"), q.Get("level"), fields["pw"], from)
	if j == nil {
		http.Error(w, why, 400)
		return
	}
	writeJ(w, j)
}
