package main

// The Converter: drop in files, pick what they should become. Pictures go through ImageMagick (reads iPhone
// HEIC photos), video and sound through FFmpeg (shared with the Downloader), office files through LibreOffice
// when it's installed. Jobs run one at a time at low priority; results land in the converted folder, and a phone
// that sent the files fetches them back.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Target struct {
	ID    string `json:"id"` // also the new file's extension
	Label string `json:"label"`
	Note  string `json:"note,omitempty"`
}

type Kind struct {
	ID      string   `json:"id"`
	Label   string   `json:"label"`
	Engine  string   `json:"engine"`
	Exts    []string `json:"exts"`
	Targets []Target `json:"targets"`
}

// Kinds lists what the Converter reads and what each kind can become, most wanted first.
var Kinds = []Kind{
	{"image", "Picture", "magick", strings.Fields("heic heif jpg jpeg png webp avif gif bmp tif tiff jxl ico dng"), []Target{
		{"jpg", "JPG", "Opens everywhere"}, {"png", "PNG", "Sharp edges, see-through parts kept"}, {"pdf", "PDF", ""},
		{"webp", "WebP", "Small, for the web"}, {"avif", "AVIF", "Smallest, newer apps only"}}},
	{"video", "Video", "ffmpeg", strings.Fields("mov mp4 m4v mkv webm avi wmv flv 3gp mts ts"), []Target{
		{"mp4", "MP4", "Plays on everything"}, {"mov", "MOV", ""}, {"webm", "WebM", ""}, {"gif", "GIF", "Short clips"},
		{"mp3", "MP3", "Sound only"}, {"m4a", "M4A", "Sound only"}}},
	{"audio", "Sound", "ffmpeg", strings.Fields("mp3 m4a aac wav flac ogg opus wma aiff aif amr caf"), []Target{
		{"mp3", "MP3", "Plays on everything"}, {"m4a", "M4A", ""}, {"wav", "WAV", "Uncompressed"}, {"flac", "FLAC", "Lossless"}, {"ogg", "OGG", ""}}},
	{"doc", "Document", "soffice", strings.Fields("docx doc odt rtf txt html htm pages wpd"), []Target{
		{"pdf", "PDF", ""}, {"docx", "Word", ""}, {"odt", "ODT", ""}, {"txt", "Plain text", ""}}},
	{"sheet", "Spreadsheet", "soffice", strings.Fields("xlsx xls ods csv numbers"), []Target{
		{"pdf", "PDF", ""}, {"xlsx", "Excel", ""}, {"ods", "ODS", ""}, {"csv", "CSV", "First sheet only"}}},
	{"slides", "Slides", "soffice", strings.Fields("pptx ppt odp key"), []Target{
		{"pdf", "PDF", ""}, {"pptx", "PowerPoint", ""}, {"odp", "ODP", ""}}},
}

// KindOf says what kind of file a name is, or nil when the Converter can't read it.
func KindOf(name string) *Kind {
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), ".")
	for i := range Kinds {
		for _, e := range Kinds[i].Exts {
			if e == ext {
				return &Kinds[i]
			}
		}
	}
	return nil
}

func (k *Kind) has(target string) bool {
	for _, t := range k.Targets {
		if t.ID == target {
			return true
		}
	}
	return false
}

type CvJob struct {
	ID      string    `json:"id"`
	Kind    string    `json:"kind"`
	Inputs  []string  `json:"inputs"` // the names as sent
	Target  string    `json:"target"`
	Small   bool      `json:"small,omitempty"`   // make the result smaller (lower quality, smaller size)
	Combine bool      `json:"combine,omitempty"` // several pictures into one PDF
	From    string    `json:"from"`              // phone id, or "" for this PC
	State   string    `json:"state"`             // queued, running, done, failed
	Pct     float64   `json:"pct"`
	Note    string    `json:"note,omitempty"`
	Files   []DLFile  `json:"files,omitempty"` // relative to the converted folder
	Size    int64     `json:"size"`            // of the results
	InSize  int64     `json:"inSize"`          // of what was sent
	At      time.Time `json:"at"`
	Fetched bool      `json:"fetched,omitempty"`
}

type Converter struct {
	mu     sync.Mutex
	path   string
	jobs   []*CvJob // newest first
	cancel map[string]context.CancelFunc
	wake   chan struct{}
	bin    func(engine string) string // path to run an engine by, "" when it isn't there
	dir    func() string
	in     string // uploads wait here until their job has run
}

func NewConverter(bin func(string) string, dir func() string) *Converter {
	c := &Converter{path: filepath.Join(appDir(), "conversions.json"), cancel: map[string]context.CancelFunc{},
		wake: make(chan struct{}, 1), bin: bin, dir: dir, in: filepath.Join(appDir(), "cv-in")}
	if b, err := os.ReadFile(c.path); err == nil {
		json.Unmarshal(b, &c.jobs)
	}
	for _, j := range c.jobs { // the program stopped mid-conversion: try again
		if j.State == "running" {
			j.State, j.Pct = "queued", 0
		}
	}
	go c.worker()
	return c
}

func (c *Converter) saveLocked() {
	if len(c.jobs) > 300 {
		for _, j := range c.jobs[300:] {
			os.RemoveAll(filepath.Join(c.in, j.ID))
		}
		c.jobs = c.jobs[:300]
	}
	writeJSON(c.path, c.jobs)
}

func (c *Converter) Jobs(from string) []CvJob {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []CvJob{}
	for _, j := range c.jobs {
		if from == "" || j.From == from {
			out = append(out, *j)
		}
	}
	return out
}

func (c *Converter) Get(id string) *CvJob {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, j := range c.jobs {
		if j.ID == id {
			cp := *j
			return &cp
		}
	}
	return nil
}

func (c *Converter) update(id string, f func(j *CvJob)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, j := range c.jobs {
		if j.ID == id {
			f(j)
			c.saveLocked()
			return
		}
	}
}

// InputDir is where a new job's uploads go before Start.
func (c *Converter) InputDir(id string) string { return filepath.Join(c.in, id) }

// Check says why these files can't become target, or "" when they can.
func (c *Converter) Check(names []string, target string, combine bool) (*Kind, string) {
	if len(names) == 0 {
		return nil, "No files came through."
	}
	k := KindOf(names[0])
	for _, n := range names {
		kn := KindOf(n)
		if kn == nil {
			if strings.EqualFold(filepath.Ext(n), ".pdf") {
				return nil, "PDFs can't be turned into other files yet. Pictures, videos, sound and office files can be."
			}
			return nil, fmt.Sprintf("%s isn't a kind of file the Converter knows.", filepath.Base(n))
		}
		if kn != k {
			return nil, "Pick files of one kind at a time (only pictures, or only videos, …)."
		}
	}
	if !k.has(target) {
		return nil, fmt.Sprintf("A %s can't become %s. It can become %s.", strings.ToLower(k.Label), strings.ToUpper(target), labels(k.Targets))
	}
	if combine && (k.ID != "image" || target != "pdf") {
		return nil, "Only pictures can be put together into one PDF."
	}
	if c.bin(k.Engine) == "" {
		return nil, missingEngine(k.Engine)
	}
	return k, ""
}

func missingEngine(engine string) string {
	switch engine {
	case "soffice":
		return "Office files need LibreOffice (free) on the PC. Install it from the Converter's Settings on the PC."
	case "magick":
		return "The picture engine is still being fetched on the PC. Try again in a minute."
	}
	return "The video engine is still being fetched on the PC. Try again in a minute."
}

// Start queues a job whose files are already in InputDir(id).
func (c *Converter) Start(id string, names []string, target string, small, combine bool, from string) (*CvJob, string) {
	k, why := c.Check(names, target, combine)
	if why != "" {
		os.RemoveAll(c.InputDir(id))
		return nil, why
	}
	var size int64
	for _, n := range names {
		if fi, err := os.Stat(filepath.Join(c.InputDir(id), n)); err == nil {
			size += fi.Size()
		}
	}
	j := &CvJob{ID: id, Kind: k.ID, Inputs: names, Target: target, Small: small, Combine: combine && len(names) > 1,
		From: from, State: "queued", InSize: size, At: time.Now()}
	c.mu.Lock()
	c.jobs = append([]*CvJob{j}, c.jobs...)
	c.saveLocked()
	c.mu.Unlock()
	select {
	case c.wake <- struct{}{}:
	default:
	}
	cp := *j
	return &cp, ""
}

func (c *Converter) Cancel(id string) {
	c.mu.Lock()
	if f := c.cancel[id]; f != nil {
		f()
	}
	c.mu.Unlock()
	c.update(id, func(j *CvJob) {
		if j.State == "queued" || j.State == "running" {
			j.State, j.Note = "failed", "Stopped."
		}
	})
}

// Remove drops a job from the history (the converted files stay in the folder).
func (c *Converter) Remove(id string) {
	c.Cancel(id)
	c.mu.Lock()
	for i, j := range c.jobs {
		if j.ID == id {
			c.jobs = append(c.jobs[:i], c.jobs[i+1:]...)
			break
		}
	}
	c.saveLocked()
	c.mu.Unlock()
	os.RemoveAll(c.InputDir(id))
}

// Path gives a job's result on disk, refusing anything outside the converted folder.
func (c *Converter) Path(j *CvJob, n int) (string, bool) {
	if n < 0 || n >= len(j.Files) {
		return "", false
	}
	dir := c.dir()
	p := filepath.Join(dir, j.Files[n].Name)
	if rel, err := filepath.Rel(dir, p); err != nil || strings.HasPrefix(rel, "..") {
		return "", false
	}
	return p, true
}

func (c *Converter) worker() {
	for {
		var id string
		c.mu.Lock()
		for i := len(c.jobs) - 1; i >= 0; i-- { // oldest queued first
			if c.jobs[i].State == "queued" {
				c.jobs[i].State = "running"
				id = c.jobs[i].ID
				break
			}
		}
		c.mu.Unlock()
		if id == "" {
			<-c.wake
			continue
		}
		c.run(id)
	}
}

func (c *Converter) run(id string) {
	j := c.Get(id)
	out := c.dir()
	ctx, cancel := context.WithCancel(context.Background())
	c.mu.Lock()
	c.cancel[id] = cancel
	c.mu.Unlock()
	defer func() {
		cancel()
		c.mu.Lock()
		delete(c.cancel, id)
		c.mu.Unlock()
	}()
	if err := os.MkdirAll(out, 0o755); err != nil {
		c.update(id, func(j *CvJob) { j.State, j.Note = "failed", "Can't use the converted folder: "+err.Error() })
		return
	}
	in := c.InputDir(id)
	var made []string
	var fails []string
	steps := len(j.Inputs)
	if j.Combine {
		steps = 1
	}
	for i := 0; i < steps; i++ {
		prog := func(p float64) {
			c.update(id, func(j *CvJob) { j.Pct = (float64(i) + p) * 100 / float64(steps) })
		}
		var files []string
		var err error
		if j.Combine {
			files, err = c.convert(ctx, j, in, j.Inputs, out, prog)
		} else {
			files, err = c.convert(ctx, j, in, j.Inputs[i:i+1], out, prog)
		}
		if ctx.Err() != nil {
			return // cancelled; Cancel already marked it
		}
		made = append(made, files...)
		if err != nil {
			name := j.Inputs[i]
			if j.Combine {
				name = "the pictures"
			}
			log.Printf("convert %s: %v", name, err)
			fails = append(fails, fmt.Sprintf("%s: %v", name, err))
		}
	}
	var res []DLFile
	var size int64
	for _, f := range made {
		fi, e := os.Stat(f)
		if e != nil {
			continue
		}
		rel, _ := filepath.Rel(out, f)
		res = append(res, DLFile{Name: rel, Size: fi.Size(), Kind: fileKind(f)})
		size += fi.Size()
	}
	os.RemoveAll(in)
	c.update(id, func(j *CvJob) {
		j.Files, j.Size, j.Pct = res, size, 100
		switch {
		case len(res) > 0 && len(fails) > 0:
			j.State, j.Note = "done", "Some files couldn't be converted. "+strings.Join(fails, " ")
		case len(res) > 0:
			j.State = "done"
		case len(fails) > 0:
			j.State, j.Note = "failed", strings.Join(fails, " ")
		default:
			j.State, j.Note = "failed", "Nothing came out."
		}
	})
	if j.From == "" {
		if jj := c.Get(id); jj != nil && jj.State == "done" {
			notify("Converter", fmt.Sprintf("Converted %d %s to %s.", len(jj.Inputs), plural(len(jj.Inputs), "file", "files"), strings.ToUpper(jj.Target)))
		}
	}
}

func labels(ts []Target) string {
	var l []string
	for _, t := range ts {
		l = append(l, t.Label)
	}
	return strings.Join(l, ", ")
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// freeName finds a name in dir that isn't taken yet: "IMG_1.jpg", then "IMG_1 (2).jpg", …
func freeName(dir, base, ext string) string {
	p := filepath.Join(dir, base+"."+ext)
	for n := 2; ; n++ {
		if _, err := os.Stat(p); os.IsNotExist(err) {
			return p
		}
		p = filepath.Join(dir, fmt.Sprintf("%s (%d).%s", base, n, ext))
	}
}

func baseName(name string) string { return strings.TrimSuffix(filepath.Base(name), filepath.Ext(name)) }

// convert turns names (in dir in) into target files in out and returns them.
func (c *Converter) convert(ctx context.Context, j *CvJob, in string, names []string, out string, prog func(float64)) ([]string, error) {
	k := KindOf(names[0])
	src := make([]string, len(names))
	for i, n := range names {
		src[i] = filepath.Join(in, n)
	}
	dst := freeName(out, baseName(names[0]), j.Target)
	if j.Combine && len(names) > 1 {
		dst = freeName(out, fmt.Sprintf("%s and %d more", baseName(names[0]), len(names)-1), "pdf")
	}
	ctx, stop := context.WithTimeout(ctx, 2*time.Hour)
	defer stop()
	var err error
	switch k.Engine {
	case "magick":
		err = c.runMagick(ctx, src, dst, j.Target, j.Small)
	case "ffmpeg":
		err = c.runFFmpeg(ctx, src[0], dst, j.Target, j.Small, prog)
	case "soffice":
		err = c.runOffice(ctx, src[0], dst, j.Target)
	}
	if err != nil {
		os.Remove(dst)
		return nil, err
	}
	return []string{dst}, nil
}

func magickArgs(src []string, dst, target string, small bool) []string {
	var args []string
	for _, s := range src {
		if target != "webp" && target != "gif" && target != "pdf" {
			s += "[0]" // a still picture from the first frame of an animated GIF or WebP
		}
		args = append(args, s)
	}
	args = append(args, "-auto-orient")
	if target == "jpg" || target == "pdf" {
		args = append(args, "-background", "white", "-alpha", "remove", "-alpha", "off")
	}
	if small {
		args = append(args, "-resize", "2048x2048>", "-strip", "-quality", "72")
	} else {
		args = append(args, "-quality", "90")
	}
	if target == "pdf" {
		args = append(args, "-compress", "jpeg")
	}
	return append(args, dst)
}

func (c *Converter) runMagick(ctx context.Context, src []string, dst, target string, small bool) error {
	return runEngine(ctx, c.bin("magick"), magickArgs(src, dst, target, small), nil)
}

func ffmpegArgs(src, dst, target string, small bool) []string {
	a := []string{"-hide_banner", "-nostdin", "-y", "-i", src}
	h264 := func(crf string) []string {
		v := []string{"-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-pix_fmt", "yuv420p"}
		if small {
			v = append(v, "-vf", "scale=-2:'min(1080,ih)'")
		}
		return v
	}
	q := func(normal, smaller string) string {
		if small {
			return smaller
		}
		return normal
	}
	switch target {
	case "mp4", "mov":
		a = append(a, h264(q("21", "28"))...)
		a = append(a, "-c:a", "aac", "-b:a", q("192k", "128k"), "-movflags", "+faststart")
	case "webm":
		a = append(a, "-c:v", "libvpx-vp9", "-crf", q("32", "40"), "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4",
			"-c:a", "libopus", "-b:a", q("128k", "96k"))
	case "gif":
		fps, w := q("15", "10"), q("540", "360")
		a = append(a, "-vf", "fps="+fps+",scale='min("+w+",iw)':-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", "-loop", "0", "-an")
	case "mp3":
		a = append(a, "-vn", "-c:a", "libmp3lame", "-q:a", q("2", "5"))
	case "m4a":
		a = append(a, "-vn", "-c:a", "aac", "-b:a", q("192k", "96k"))
	case "wav":
		a = append(a, "-vn", "-c:a", "pcm_s16le")
	case "flac":
		a = append(a, "-vn", "-c:a", "flac")
	case "ogg":
		a = append(a, "-vn", "-c:a", "libopus", "-b:a", q("128k", "64k"))
	}
	return append(a, "-progress", "pipe:1", "-nostats", dst)
}

var outTimeRe = regexp.MustCompile(`^out_time_us=(\d+)`)

func (c *Converter) runFFmpeg(ctx context.Context, src, dst, target string, small bool, prog func(float64)) error {
	dur := 0.0
	if b, err := hidden(exec.CommandContext(ctx, c.bin("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src)).Output(); err == nil {
		dur, _ = strconv.ParseFloat(strings.TrimSpace(string(b)), 64)
	}
	return runEngine(ctx, c.bin("ffmpeg"), ffmpegArgs(src, dst, target, small), func(line string) {
		if m := outTimeRe.FindStringSubmatch(line); m != nil && dur > 0 {
			us, _ := strconv.ParseFloat(m[1], 64)
			prog(min(0.99, us/1e6/dur))
		}
	})
}

// LibreOffice's names for what to save as.
var officeFilter = map[string]string{"txt": "txt:Text (encoded):UTF8", "csv": "csv:Text - txt - csv (StarCalc):44,34,76,1"}

func (c *Converter) runOffice(ctx context.Context, src, dst, target string) error {
	tmp, err := os.MkdirTemp(filepath.Dir(src), "lo-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	to := target
	if f := officeFilter[target]; f != "" {
		to = f
	}
	// Its own profile, so an open LibreOffice window doesn't block it. A file URL, so the space in "Premade Tools" is escaped.
	profile := (&url.URL{Scheme: "file", Path: "/" + strings.TrimPrefix(filepath.ToSlash(filepath.Join(appDir(), "lo-profile")), "/")}).String()
	ctx, stop := context.WithTimeout(ctx, 5*time.Minute) // a stuck LibreOffice shouldn't block the queue
	defer stop()
	args := []string{"-env:UserInstallation=" + profile, "--headless", "--norestore", "--nolockcheck", "--convert-to", to, "--outdir", tmp, src}
	if err := runEngine(ctx, c.bin("soffice"), args, nil); err != nil {
		return err
	}
	got := filepath.Join(tmp, baseName(src)+"."+target)
	if _, err := os.Stat(got); err != nil {
		return fmt.Errorf("LibreOffice couldn't open it")
	}
	if err := os.Rename(got, dst); err != nil {
		return copyFile(got, dst)
	}
	return nil
}

// runEngine runs a converter program, passing each line of its output to line, and turns a failure into a
// short reason.
func runEngine(ctx context.Context, bin string, args []string, line func(string)) error {
	if bin == "" {
		return fmt.Errorf("the engine isn't installed")
	}
	cmd := hidden(exec.CommandContext(ctx, bin, args...))
	var errBuf strings.Builder
	cmd.Stderr = &limitWriter{b: &errBuf, n: 8 << 10}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("couldn't start %s", filepath.Base(bin))
	}
	sc := bufio.NewScanner(stdout)
	for sc.Scan() {
		if line != nil {
			line(sc.Text())
		}
	}
	if err := cmd.Wait(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("%s", engineError(errBuf.String()))
	}
	return nil
}

// engineError picks the line that says what went wrong.
func engineError(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		l := strings.TrimSpace(lines[i])
		if l == "" || strings.HasPrefix(l, "Conversion failed") {
			continue
		}
		if len(l) > 200 {
			l = l[:200] + "…"
		}
		return "the file couldn't be read (" + l + ")"
	}
	return "the file couldn't be read"
}

type limitWriter struct {
	b *strings.Builder
	n int
}

func (w *limitWriter) Write(p []byte) (int, error) {
	if w.b.Len() < w.n {
		w.b.Write(p)
	} else { // keep the end, where the reason is
		s := w.b.String()
		w.b.Reset()
		w.b.WriteString(s[len(s)/2:])
		w.b.Write(p)
	}
	return len(p), nil
}

// officeBin finds LibreOffice: installed for all users, for this user, or (off Windows) on PATH.
func officeBin() string {
	if runtime.GOOS != "windows" {
		if p, err := exec.LookPath("soffice"); err == nil {
			return p
		}
		return ""
	}
	for _, d := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs")} {
		for _, exe := range []string{"soffice.com", "soffice.exe"} { // .com waits for the conversion to finish
			p := filepath.Join(d, "LibreOffice", "program", exe)
			if _, err := os.Stat(p); err == nil && d != "" {
				return p
			}
		}
	}
	return ""
}
