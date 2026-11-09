package main

import (
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
)

// testPDF makes a PDF with n pages (one picture each) and returns its path.
func testPDF(t *testing.T, dir, name string, n int) string {
	var imgs []string
	for i := 0; i < n; i++ {
		m := image.NewRGBA(image.Rect(0, 0, 60, 80))
		for x := 0; x < 60; x++ {
			for y := 0; y < 80; y++ {
				m.Set(x, y, color.RGBA{uint8(40 * i), uint8(x * 4), uint8(y * 3), 255})
			}
		}
		p := filepath.Join(dir, name+string(rune('a'+i))+".png")
		f, _ := os.Create(p)
		png.Encode(f, m)
		f.Close()
		imgs = append(imgs, p)
	}
	out := filepath.Join(dir, name+".pdf")
	if err := api.ImportImagesFile(context.Background(), imgs, out, nil, nil); err != nil {
		t.Fatal(err)
	}
	return out
}

func pageCount(t *testing.T, p string) int {
	n, err := api.PageCountFile(context.Background(), p)
	if err != nil {
		t.Fatalf("%s: %v", p, err)
	}
	return n
}

func TestPdfCheck(t *testing.T) {
	for _, tc := range []struct {
		names     []string
		op, pages string
		pw        string
		bad       bool
	}{
		{[]string{"a.pdf", "b.PDF"}, "merge", "", "", false},
		{[]string{"a.pdf"}, "merge", "", "", true},
		{[]string{"a.jpg"}, "compress", "", "", true},
		{[]string{"a.pdf"}, "pages", "3,1r90,2r270", "", false},
		{[]string{"a.pdf"}, "pages", "1r45", "", true},
		{[]string{"a.pdf"}, "extract", "", "", true},
		{[]string{"a.pdf", "b.pdf"}, "split", "", "", true},
		{[]string{"a.pdf"}, "edit", "", "", false},
		{[]string{"a.pdf", "b.pdf"}, "edit", "", "", true},
		{[]string{"a.pdf"}, "lock", "", "", true},
		{[]string{"a.pdf"}, "wipe", "", "", true},
	} {
		if why := PdfCheck(tc.names, tc.op, tc.pages, tc.pw); (why != "") != tc.bad {
			t.Errorf("%v %s %q: %q", tc.names, tc.op, tc.pages, why)
		}
	}
}

func TestPdfWork(t *testing.T) {
	in, out := t.TempDir(), t.TempDir()
	a, b := testPDF(t, in, "a", 3), testPDF(t, in, "b", 2)
	c := &Converter{}
	ctx := context.Background()
	run := func(j *CvJob) []string {
		t.Helper()
		made, fails := c.pdfWork(ctx, j, in, out, func(float64) {})
		if len(fails) > 0 {
			t.Fatalf("%s: %v", j.Target, fails)
		}
		return made
	}

	if m := run(&CvJob{Target: "merge", Inputs: []string{filepath.Base(a), filepath.Base(b)}}); len(m) != 1 || pageCount(t, m[0]) != 5 {
		t.Fatalf("merge: %v", m)
	}
	m := run(&CvJob{Target: "pages", Inputs: []string{"a.pdf"}, Pages: "3,1r90"})
	if pageCount(t, m[0]) != 2 {
		t.Fatal("pages")
	}
	if dims, err := api.PageDimsFile(ctx, m[0]); err != nil || dims[1].Width <= dims[1].Height { // page 1, now second, turned sideways
		t.Fatalf("turn: %v %v", dims, err)
	}
	if m := run(&CvJob{Target: "extract", Inputs: []string{"a.pdf"}, Pages: "2"}); pageCount(t, m[0]) != 1 {
		t.Fatal("extract")
	}
	if m := run(&CvJob{Target: "split", Inputs: []string{"a.pdf"}}); len(m) != 3 || filepath.Base(m[2]) != "a p3.pdf" {
		t.Fatalf("split: %v", m)
	}
	if m := run(&CvJob{Target: "edit", Inputs: []string{"a.pdf"}}); filepath.Base(m[0]) != "a (edited).pdf" || pageCount(t, m[0]) != 3 {
		t.Fatalf("edit: %v", m)
	}
	if m := run(&CvJob{Target: "compress", Inputs: []string{"a.pdf"}}); pageCount(t, m[0]) != 3 {
		t.Fatal("compress")
	}

	locked := run(&CvJob{Target: "lock", Inputs: []string{"a.pdf"}, pw: "s3cret"})[0]
	if _, err := api.PageCountFile(ctx, locked); err == nil {
		t.Fatal("locked PDF opened without the password")
	}
	os.Rename(locked, filepath.Join(in, "l.pdf"))
	if _, fails := c.pdfWork(ctx, &CvJob{Target: "unlock", Inputs: []string{"l.pdf"}, pw: "nope"}, in, out, func(float64) {}); len(fails) != 1 {
		t.Fatal("wrong password unlocked it")
	}
	if m := run(&CvJob{Target: "unlock", Inputs: []string{"l.pdf"}, pw: "s3cret"}); pageCount(t, m[0]) != 3 {
		t.Fatal("unlock")
	}
	if _, fails := c.pdfWork(ctx, &CvJob{Target: "merge", Inputs: []string{"l.pdf", "b.pdf"}}, in, out, func(float64) {}); len(fails) != 1 {
		t.Fatal("merged a locked PDF")
	} else {
		t.Log(fails[0])
	}
	// A job that failed leaves no empty file behind in the folder.
	ents, _ := os.ReadDir(out)
	for _, e := range ents {
		if fi, _ := e.Info(); fi.Mode().IsRegular() && fi.Size() == 0 {
			t.Errorf("%s was left behind, empty", e.Name())
		}
	}
}
