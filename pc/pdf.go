package main

// The PDF tools: merge, split or pull out pages, reorder/turn/delete pages, compress, add or remove a password.
// pdfcpu (built in) does all of it; Ghostscript, when it's on the PC, makes scanned and photo-heavy PDFs much
// smaller. Jobs run on the Converter's queue, so phones send files and fetch results the same way.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

// PdfOps lists what the PDF tools do, in the order the screens show them.
var PdfOps = []Target{
	{"edit", "Edit", "Change the text, add text, pictures, a signature or drawings"},
	{"merge", "Merge", "Put PDFs together into one, in the order you pick"},
	{"pages", "Pages", "Reorder, turn or delete pages"},
	{"extract", "Pick pages", "Save only the pages you pick as a new PDF"},
	{"split", "Split", "Every page as its own PDF"},
	{"compress", "Compress", "Make it smaller to send"},
	{"lock", "Add password", "It asks for the password to open"},
	{"unlock", "Remove password", "Opens without asking"},
}

var gs = &installer{id: "ArtifexSoftware.GhostScript", name: "Ghostscript", site: "ghostscript.com", bin: gsBin,
	tool: "PDF", doneNote: "Ghostscript is installed. Compressed PDFs come out much smaller now."}

func init() { api.DisableConfigDir() } // pdfcpu would otherwise make its own folder in the user's settings

func NewPdfTools(dir func() string) *Converter {
	c := newQueue("pdf-jobs.json", "pdf-in", func(string) string { return gsBin() }, dir)
	c.work = c.pdfWork
	c.notify = func(j *CvJob) { notify("PDF", pdfDoneNote(j)) }
	go c.worker()
	return c
}

func pdfDoneNote(j *CvJob) string {
	n := len(j.Inputs)
	switch j.Target {
	case "merge":
		return fmt.Sprintf("Merged %d PDFs.", n)
	case "split":
		return fmt.Sprintf("Split into %d PDFs.", len(j.Files))
	case "compress":
		return fmt.Sprintf("Compressed: %s → %s.", human(j.InSize), human(j.Size))
	case "edit":
		return "Saved the edited PDF."
	case "lock":
		return "Password added."
	case "unlock":
		return "Password removed."
	}
	return "Saved the new PDF."
}

var pagesRe = regexp.MustCompile(`^\d{1,5}(r(90|180|270))?(,\d{1,5}(r(90|180|270))?)*$`)

// PdfCheck says why these files can't go through op, or "".
func PdfCheck(names []string, op, pages, pw string) string {
	if len(names) == 0 {
		return "No files came through."
	}
	for _, n := range names {
		if !strings.EqualFold(filepath.Ext(n), ".pdf") {
			return filepath.Base(n) + " isn't a PDF. To turn pictures or documents into a PDF, use the Converter."
		}
	}
	switch op {
	case "merge":
		if len(names) < 2 {
			return "Pick at least two PDFs to merge."
		}
	case "edit", "pages", "extract", "split":
		if len(names) > 1 {
			return "Pick one PDF at a time for this."
		}
		if (op == "pages" || op == "extract") && !pagesRe.MatchString(pages) {
			return "Pick at least one page."
		}
	case "lock", "unlock":
		if pw == "" {
			return "Type the password."
		}
	case "compress":
	default:
		return "Pick what to do with the PDF."
	}
	return ""
}

// StartPdf queues a job whose files are already in InputDir(id).
func (c *Converter) StartPdf(id string, names []string, op, pages, level, pw, from string) (*CvJob, string) {
	if why := PdfCheck(names, op, pages, pw); why != "" {
		os.RemoveAll(c.InputDir(id))
		return nil, why
	}
	return c.add(&CvJob{ID: id, Kind: "pdf", Inputs: names, Target: op, Pages: pages, Small: level == "smallest", From: from, pw: pw}), ""
}

func pdfConf() *model.Configuration {
	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed
	return conf
}

// pdfErr turns pdfcpu's error into something a person can act on.
func pdfErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, pdfcpu.ErrWrongPassword):
		return fmt.Errorf("that password didn't open it")
	case errors.Is(err, pdfcpu.ErrNotEncrypted):
		return fmt.Errorf("it has no password")
	case strings.Contains(err.Error(), "password") || strings.Contains(err.Error(), "is encrypted") || errors.Is(err, pdfcpu.ErrPermissionDenied):
		return fmt.Errorf("it has a password. Remove it first with Remove password")
	case errors.Is(err, context.Canceled):
		return err
	}
	l := err.Error()
	if len(l) > 160 {
		l = l[:160] + "…"
	}
	return fmt.Errorf("the PDF couldn't be read (%s)", l)
}

func (c *Converter) pdfWork(ctx context.Context, j *CvJob, in, out string, prog func(float64)) (made, fails []string) {
	src := make([]string, len(j.Inputs))
	for i, n := range j.Inputs {
		src[i] = filepath.Join(in, n)
	}
	ctx, stop := context.WithTimeout(ctx, time.Hour)
	defer stop()
	fail := func(name string, err error) { fails = append(fails, fmt.Sprintf("%s: %v.", name, pdfErr(err))) }
	base := baseName(j.Inputs[0])

	switch j.Target {
	case "merge":
		dst := freeName(out, base+" merged", "pdf")
		if err := api.MergeCreateFile(ctx, src, dst, false, pdfConf()); err != nil {
			os.Remove(dst)
			fail("Merging", err)
			return
		}
		made = append(made, dst)
	case "pages", "extract":
		name := map[string]string{"pages": " edited", "extract": " pages"}[j.Target]
		dst := freeName(out, base+name, "pdf")
		if err := editPages(ctx, src[0], dst, j.Pages); err != nil {
			os.Remove(dst)
			fail(j.Inputs[0], err)
			return
		}
		made = append(made, dst)
	case "edit": // the editor on the screen made the new PDF; the PC keeps it and sends it back
		dst := freeName(out, base+" (edited)", "pdf")
		if err := copyFile(src[0], dst); err != nil {
			fail(j.Inputs[0], err)
			return
		}
		made = append(made, dst)
	case "split":
		files, err := splitPages(ctx, src[0], out, base)
		if err != nil {
			fail(j.Inputs[0], err)
			return
		}
		made = files
	default: // compress, lock and unlock go file by file
		for i, s := range src {
			prog(float64(i) * 100 / float64(len(src)))
			var dst string
			var err error
			switch j.Target {
			case "compress":
				if j.From == "" && gsBin() == "" {
					go gs.Install() // first compress on the PC: fetch Ghostscript for next time (Windows asks once)
				}
				dst = freeName(out, baseName(s)+" smaller", "pdf")
				err = c.compress(ctx, s, dst, j.Small)
			case "lock":
				dst = freeName(out, baseName(s)+" locked", "pdf")
				err = withPassword(ctx, s, dst, j.pw, true)
			case "unlock":
				dst = freeName(out, baseName(s)+" unlocked", "pdf")
				err = withPassword(ctx, s, dst, j.pw, false)
			}
			if ctx.Err() != nil {
				return nil, nil
			}
			if err != nil {
				os.Remove(dst)
				fail(j.Inputs[i], err)
				continue
			}
			made = append(made, dst)
		}
	}
	return
}

// withPassword adds pw (to open, and to change it) or opens the file with pw and saves it without one.
// A job the PC picked up again after a restart has no password left: it was never written down.
func withPassword(ctx context.Context, src, dst, pw string, add bool) error {
	if pw == "" {
		return fmt.Errorf("the PC restarted before it got to this. Send it again")
	}
	conf := model.NewAESConfiguration(pw, pw, 256)
	conf.ValidationMode = model.ValidationRelaxed
	if add {
		return api.EncryptFile(ctx, src, dst, conf)
	}
	return api.DecryptFile(ctx, src, dst, conf)
}

// editPages saves the pages of spec ("3,1r90,2": page numbers in their new order, each maybe turned) as dst.
func editPages(ctx context.Context, src, dst, spec string) error {
	n, err := api.PageCountFile(ctx, src)
	if err != nil {
		return err
	}
	var order []string
	turn := map[int][]string{} // degrees → new positions
	for i, t := range strings.Split(spec, ",") {
		num, deg, _ := strings.Cut(t, "r")
		p, _ := strconv.Atoi(num)
		if p < 1 || p > n {
			return fmt.Errorf("it has %d pages, so there's no page %d", n, p)
		}
		order = append(order, num)
		if d, _ := strconv.Atoi(deg); d != 0 {
			turn[d] = append(turn[d], strconv.Itoa(i+1))
		}
	}
	if err := api.CollectFile(ctx, src, dst, order, pdfConf()); err != nil {
		return err
	}
	for d, ps := range turn {
		if err := api.RotateFile(ctx, dst, "", d, ps, pdfConf()); err != nil {
			return err
		}
	}
	return nil
}

var spanNumRe = regexp.MustCompile(`_(\d+)\.pdf$`)

// splitPages saves every page as its own PDF in a new folder "<base> split" in out.
func splitPages(ctx context.Context, src, out, base string) ([]string, error) {
	tmp, err := os.MkdirTemp(filepath.Dir(src), "split-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)
	if err := api.SplitFile(ctx, src, tmp, 1, pdfConf()); err != nil {
		return nil, err
	}
	ents, _ := os.ReadDir(tmp)
	num := func(n string) int {
		m := spanNumRe.FindStringSubmatch(n)
		if m == nil {
			return 0
		}
		v, _ := strconv.Atoi(m[1])
		return v
	}
	sort.Slice(ents, func(a, b int) bool { return num(ents[a].Name()) < num(ents[b].Name()) })
	dir := filepath.Join(out, base+" split")
	for k := 2; ; k++ { // a folder from an earlier split stays as it is
		if _, err := os.Stat(dir); os.IsNotExist(err) {
			break
		}
		dir = filepath.Join(out, fmt.Sprintf("%s split (%d)", base, k))
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	var files []string
	for i, e := range ents {
		dst := filepath.Join(dir, fmt.Sprintf("%s p%d.pdf", base, i+1))
		if err := moveFile(filepath.Join(tmp, e.Name()), dst); err != nil {
			return files, err
		}
		files = append(files, dst)
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("no pages came out")
	}
	return files, nil
}

func moveFile(from, to string) error {
	if err := os.Rename(from, to); err != nil {
		return copyFile(from, to)
	}
	return nil
}

// compress keeps the smallest of: pdfcpu's tidy-up (same quality), Ghostscript's rewrite (pictures made
// smaller) when it's on the PC, and the original.
func (c *Converter) compress(ctx context.Context, src, dst string, smallest bool) error {
	tidy := dst + ".tidy"
	defer os.Remove(tidy)
	if err := api.OptimizeFile(ctx, src, tidy, pdfConf(), nil); err != nil {
		return err
	}
	cands := []string{src, tidy}
	if bin := gsBin(); bin != "" {
		re := dst + ".gs"
		defer os.Remove(re)
		if err := runEngine(ctx, bin, gsArgs(tidy, re, smallest), nil); err == nil {
			cands = append(cands, re)
		}
	}
	best, bestSize := "", int64(-1)
	for _, f := range cands {
		if fi, err := os.Stat(f); err == nil && (bestSize < 0 || fi.Size() < bestSize) {
			best, bestSize = f, fi.Size()
		}
	}
	if best == src {
		return copyFile(src, dst) // already as small as it gets
	}
	return moveFile(best, dst)
}

func gsArgs(src, dst string, smallest bool) []string {
	set, dpi := "/ebook", "150" // sharp on screens and fine to print at home
	if smallest {
		set, dpi = "/screen", "96"
	}
	return []string{"-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.6", "-dPDFSETTINGS=" + set,
		"-dColorImageResolution=" + dpi, "-dGrayImageResolution=" + dpi, "-dDetectDuplicateImages=true", "-sOutputFile=" + dst, src}
}

// gsBin finds Ghostscript: the newest one installed (winget puts it in Program Files\gs\gs10.x), or gs on PATH.
func gsBin() string {
	if runtime.GOOS != "windows" {
		p, _ := exec.LookPath("gs")
		return p
	}
	var found []string
	for _, d := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")} {
		if d == "" {
			continue
		}
		for _, exe := range []string{"gswin64c.exe", "gswin32c.exe"} {
			m, _ := filepath.Glob(filepath.Join(d, "gs", "gs*", "bin", exe))
			found = append(found, m...)
		}
	}
	if len(found) == 0 {
		return ""
	}
	sort.Strings(found) // versions are zero-padded (gs10.05.1), so the last is the newest
	return found[len(found)-1]
}
