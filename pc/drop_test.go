package main

import (
	"archive/zip"
	"bytes"
	"log"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDrops(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	pc := t.TempDir()
	d := NewDrops(func() string { return pc })

	if it, _ := d.Add("ph1", "pc", " https://x.com/a/status/1 ", "", nil); it.Kind != "link" {
		t.Fatalf("link: %+v", it)
	}
	if it, _ := d.Add("ph1", "pc", "hello there", "", nil); it.Kind != "text" {
		t.Fatalf("text: %+v", it)
	}
	if _, err := d.Add("ph1", "pc", "  ", "", nil); err == nil {
		t.Fatal("empty drop accepted")
	}
	// Two files with one name into the PC folder: the second gets a new name, nothing is overwritten.
	for i := 0; i < 2; i++ {
		tmp := t.TempDir()
		os.WriteFile(filepath.Join(tmp, "a.jpg"), []byte{0xFF, 0xD8, byte(i)}, 0o644)
		it, err := d.Add("ph1", "pc", "", tmp, []string{"a.jpg"})
		if err != nil || it.Files[0].Kind != "photo" {
			t.Fatalf("file: %v %+v", err, it)
		}
	}
	if _, err := os.Stat(filepath.Join(pc, "a (2).jpg")); err != nil {
		t.Fatal("second a.jpg overwrote the first")
	}
	// A drop for a phone waits in the hold folder and is served from there.
	tmp := t.TempDir()
	os.WriteFile(filepath.Join(tmp, "n.pdf"), []byte("%PDF"), 0o644)
	it, _ := d.Add("pc", "ph2", "", tmp, []string{"n.pdf"})
	if p, ok := d.Path(it, 0); !ok || filepath.Dir(p) != filepath.Join(d.hold, it.ID) {
		t.Fatalf("held file at %q", p)
	}
	if n := len(d.List("ph2")); n != 1 {
		t.Fatalf("ph2 sees %d drops", n)
	}
	// It all survives a restart, and old drops clear (taking held files, keeping the PC's).
	d = NewDrops(func() string { return pc })
	if len(d.List("")) != 5 {
		t.Fatalf("after restart: %d", len(d.List("")))
	}
	d.Clear(time.Now().Add(8 * 24 * time.Hour))
	if len(d.List("")) != 0 {
		t.Fatal("old drops kept")
	}
	if _, err := os.Stat(filepath.Join(d.hold, it.ID)); !os.IsNotExist(err) {
		t.Fatal("held file kept")
	}
	if _, err := os.Stat(filepath.Join(pc, "a.jpg")); err != nil {
		t.Fatal("PC file removed")
	}
	if !d.SetClip("pc", "x") || d.SetClip("ph1", "x") {
		t.Fatal("clip repeat not ignored")
	}
}

// Two phones dropping a file with one name at the same moment (two "Note.txt"s): both land, neither overwrites
// the other.
func TestDropsSameNameAtOnce(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	pc := t.TempDir()
	d := NewDrops(func() string { return pc })
	var wg sync.WaitGroup
	for i := range 20 {
		tmp := t.TempDir()
		os.WriteFile(filepath.Join(tmp, "Note.txt"), []byte{byte(i)}, 0o644)
		wg.Add(1)
		go func() { defer wg.Done(); d.Add("ph1", "pc", "", tmp, []string{"Note.txt"}) }()
	}
	wg.Wait()
	got := map[string]bool{}
	for _, it := range d.List("") {
		b, _ := os.ReadFile(filepath.Join(pc, it.Files[0].Name))
		got[string(b)] = true
	}
	if len(got) != 20 {
		t.Fatalf("%d of 20 notes are still there", len(got))
	}
}

// Long text sent with File drop arrives whole (it was cut at 4 KB, mid-letter), and text past what a clipboard
// takes is refused with a reason instead of cut.
func TestLongDropText(t *testing.T) {
	a, h := testApp(t)
	a.drops = NewDrops(func() string { return t.TempDir() })
	send := func(text string) *httptest.ResponseRecorder {
		var b bytes.Buffer
		mw := multipart.NewWriter(&b)
		mw.WriteField("text", text)
		mw.Close()
		return call(h, "POST", "/api/phone/drop/send?to=pc", &b, "Content-Type", mw.FormDataContentType())
	}
	long := strings.Repeat("مرحبا بالعالم ", 1000)
	if w := send(long); w.Code != 200 {
		t.Fatalf("long text: %d %s", w.Code, w.Body)
	}
	if got := a.drops.List("pc"); len(got) != 1 || got[0].Text != strings.TrimSpace(long) {
		t.Fatalf("the text arrived cut: %d drops, %d of %d bytes", len(got), len(got[0].Text), len(long))
	}
	if w := send(strings.Repeat("a", 300<<10)); w.Code != 400 {
		t.Fatalf("too long: %d %s", w.Code, w.Body)
	}
	if n := dropNote(&a.drops.List("pc")[0]); len([]rune(n)) > 201 {
		t.Fatalf("a push would carry %d letters", len([]rune(n)))
	}
}

// A phone's big file comes in pieces (the relay takes nothing over 100 MB in one call): a piece sent again replaces
// itself, one out of order or with a bad id is refused, and the upload then takes the whole file by its id.
func TestPiecesUpload(t *testing.T) {
	a, h := testApp(t)
	a.drops = NewDrops(func() string { return t.TempDir() })
	u := strings.Repeat("ab", 16)
	put := func(id, at, body string) int {
		return call(h, "PUT", "/api/phone/piece?u="+id+"&at="+at, strings.NewReader(body)).Code
	}
	for _, p := range [][2]string{{"0", "hello "}, {"6", "wor"}, {"6", "world"}} { // the second try of a piece that broke
		if c := put(u, p[0], p[1]); c != 200 {
			t.Fatalf("piece at %s: %d", p[0], c)
		}
	}
	if put(u, "99", "x") != 400 || put("../../x", "0", "x") != 400 || put(u, "-1", "x") != 400 {
		t.Fatal("a piece out of order or with a bad id was taken")
	}
	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	mw.WriteField("p", u+"/clip.mov")
	mw.Close()
	if w := call(h, "POST", "/api/phone/drop/send?to=pc", &b, "Content-Type", mw.FormDataContentType()); w.Code != 200 {
		t.Fatalf("send by pieces: %d %s", w.Code, w.Body)
	}
	it := a.drops.List("pc")[0]
	if p, ok := a.drops.Path(&it, 0); !ok || it.Files[0].Name != "clip.mov" {
		t.Fatalf("the drop: %+v", it)
	} else if got, _ := os.ReadFile(p); string(got) != "hello world" {
		t.Fatalf("the file arrived as %q", got)
	}
	if _, err := os.Stat(piecePath(u)); err == nil {
		t.Fatal("the pieces stayed behind")
	}

	b.Reset()
	mw = multipart.NewWriter(&b)
	mw.WriteField("p", u+"/clip.mov") // already taken
	mw.Close()
	if w := call(h, "POST", "/api/phone/drop/send?to=pc", &b, "Content-Type", mw.FormDataContentType()); w.Code != 400 {
		t.Fatalf("a file whose pieces never came: %d", w.Code)
	}
}

// The Drop to PC Shortcut sends names without their extensions: a document gets its own back from its first bytes,
// and only plain text that's no known kind of file arrives as text.
func TestDropShortcutTypes(t *testing.T) {
	a, h := testApp(t)
	a.drops = NewDrops(func() string { return t.TempDir() })
	var docx bytes.Buffer
	zw := zip.NewWriter(&docx)
	for _, n := range []string{"[Content_Types].xml", "word/document.xml"} {
		f, _ := zw.Create(n)
		f.Write([]byte("<w/>"))
	}
	zw.Close()
	for body, want := range map[string]string{"%PDF-1.1\ntrailer<</Root 1 0 R>>\n%%EOF": "Report.pdf", docx.String(): "Report.docx",
		"{\\rtf1\\ansi hello}": "Report.rtf", "see you at 5": "text"} {
		if w := call(h, "POST", "/api/phone/drop/ios?to=pc&name=Report", strings.NewReader(body)); !strings.HasPrefix(w.Body.String(), "OK") {
			t.Fatalf("%s: %s", want, w.Body)
		}
		got := a.drops.List("pc")[0]
		if name := got.Kind; len(got.Files) > 0 && got.Files[0].Name != want || len(got.Files) == 0 && name != want {
			t.Errorf("sent as %s, arrived as %s %+v", want, got.Kind, got.Files)
		}
	}
}

// A note typed with files goes with them, and shows in the pop-up.
func TestDropNoteWithFiles(t *testing.T) {
	a, h := testApp(t)
	a.drops = NewDrops(func() string { return t.TempDir() })
	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	mw.WriteField("text", "receipts for March")
	f, _ := mw.CreateFormFile("f", "march.pdf")
	f.Write([]byte("%PDF-1.4"))
	mw.Close()
	if w := call(h, "POST", "/api/phone/drop/send?to=pc", &b, "Content-Type", mw.FormDataContentType()); w.Code != 200 {
		t.Fatalf("send: %d %s", w.Code, w.Body)
	}
	it := a.drops.List("pc")[0]
	if it.Kind != "files" || it.Text != "receipts for March" || dropNote(&it) != "march.pdf: receipts for March" {
		t.Fatalf("%s %q %q", it.Kind, it.Text, dropNote(&it))
	}
}

// Files the S23 shares one by one make one pop-up on the PC, not one each.
func TestDropOnePopUp(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("pop-ups are real there")
	}
	a, h := testApp(t)
	a.drops = NewDrops(func() string { return t.TempDir() })
	old := burstWait
	burstWait = 100 * time.Millisecond
	defer func() { burstWait = old }()
	var logs bytes.Buffer
	log.SetOutput(&logs)
	for _, n := range []string{"a", "b", "c"} {
		call(h, "POST", "/api/phone/drop/ios?to=pc&name="+n, strings.NewReader("\xff\xd8\xff\xe0"))
	}
	time.Sleep(400 * time.Millisecond)
	log.SetOutput(os.Stderr) // waits for any write still going
	if out := logs.String(); strings.Count(out, "S23 sent 3 files") != 1 || strings.Contains(out, ".jpg") {
		t.Fatalf("pop-ups: %s", out)
	}
}
