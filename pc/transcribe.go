package main

// Transcribe: voice memos, videos and downloaded clips become text and subtitles. whisper.cpp (MIT) runs on this
// PC, on the NVIDIA card when there is one, with OpenAI's Whisper models (MIT). Nothing is sent anywhere. The
// engine (~650 MB with CUDA) and the model (~1.6 GB) are fetched once, the first time they're needed. Jobs run
// on the Converter's queue, so phones send files and fetch results the same way.

import (
	"archive/zip"
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
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

// The models: large-v3-turbo is fast and good in Arabic and English but was trained without translating, so
// "Translate to English" uses medium, which does both.
var trModels = map[string]string{
	"text": "ggml-large-v3-turbo.bin", // ~1.6 GB
	"en":   "ggml-medium.bin",         // ~1.5 GB, fetched the first time something is translated
}

// whisperEng fetches whisper.cpp and the models, and says where they are.
type whisperEng struct {
	mu   sync.Mutex
	run  sync.Mutex // one fetch at a time
	busy string     // what's being fetched, "" when nothing
	pct  float64
	err  string
}

var whisper = &whisperEng{}

func (w *whisperEng) dir() string { return filepath.Join(appDir(), "engines", "whisper") }

// Bin is whisper-cli, or "" when it isn't here yet. Off Windows (development) it comes from PATH.
func (w *whisperEng) Bin() string {
	if runtime.GOOS != "windows" {
		p, _ := exec.LookPath("whisper-cli")
		return p
	}
	p := filepath.Join(w.dir(), "whisper-cli.exe")
	if _, err := os.Stat(p); err != nil {
		return ""
	}
	return p
}

// Model is where a model lives (kept outside the engine folder so a new engine doesn't drop it).
func (w *whisperEng) Model(target string) string {
	return filepath.Join(appDir(), "engines", "whisper-models", trModels[target])
}

func (w *whisperEng) has(target string) bool {
	fi, err := os.Stat(w.Model(target))
	return w.Bin() != "" && err == nil && fi.Size() > 100<<20
}

// GPU says whether this PC has an NVIDIA card (its driver puts nvidia-smi in System32).
func gpu() bool {
	_, err := os.Stat(filepath.Join(os.Getenv("SystemRoot"), "System32", "nvidia-smi.exe"))
	return err == nil
}

// State is "ok" (ready to transcribe), "missing", "installing" or "error: why", with how far a fetch is.
func (w *whisperEng) State() map[string]any {
	w.mu.Lock()
	defer w.mu.Unlock()
	st := "missing"
	switch {
	case w.busy != "":
		st = "installing"
	case w.has("text"):
		st = "ok"
	case w.err != "":
		st = "error: " + w.err
	}
	return map[string]any{"state": st, "pct": int(w.pct), "gpu": gpu(), "translate": w.has("en")}
}

func (w *whisperEng) set(busy string, pct float64) {
	w.mu.Lock()
	w.busy, w.pct = busy, pct
	w.mu.Unlock()
}

// Install fetches whatever target still needs, passing on how far along it is (0-100).
func (w *whisperEng) Install(target string, prog func(float64)) error {
	w.run.Lock()
	defer w.run.Unlock()
	if w.has(target) {
		return nil
	}
	if prog == nil {
		prog = func(float64) {}
	}
	err := func() error {
		if runtime.GOOS != "windows" && w.Bin() == "" {
			return fmt.Errorf("put whisper-cli on PATH")
		}
		cl := &http.Client{Timeout: 3 * time.Hour}
		engShare := 0.0
		if w.Bin() == "" {
			engShare = 30
			w.set("engine", 0)
			if err := w.fetchEngine(cl, func(p float64) { w.set("engine", p*engShare/100); prog(p * engShare / 100) }); err != nil {
				return err
			}
		}
		if fi, err := os.Stat(w.Model(target)); err == nil && fi.Size() > 100<<20 {
			return nil
		}
		w.set("model", engShare)
		url := "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/" + trModels[target]
		dst := w.Model(target)
		os.MkdirAll(filepath.Dir(dst), 0o755)
		return download(cl, url, dst, func(p float64) { v := engShare + p*(100-engShare)/100; w.set("model", v); prog(v) })
	}()
	w.mu.Lock()
	w.busy, w.pct, w.err = "", 0, ""
	if err != nil {
		log.Printf("whisper install: %v", err)
		w.err = err.Error()
	}
	w.mu.Unlock()
	return err
}

// whisperAsset is the build to fetch: CUDA 12 for NVIDIA cards, the plain one otherwise.
func whisperAsset() *regexp.Regexp {
	if gpu() {
		return regexp.MustCompile(`^whisper-bin-win-cuda-12\.[0-9.]+-x64\.zip$`)
	}
	return regexp.MustCompile(`^whisper-bin-x64\.zip$`)
}

// fetchEngine unpacks the newest whisper.cpp Windows build into engines\whisper. The numbered releases
// (v1.9.5) carry no files; the nightly ones (b5454) do, so it takes the newest release that has the build.
// ponytail: fetched once and never refreshed; add it to engineList's 30-day refresh if a fix is ever needed.
func (w *whisperEng) fetchEngine(cl *http.Client, prog func(float64)) error {
	resp, err := cl.Get("https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15")
	if err != nil {
		return fmt.Errorf("couldn't reach GitHub")
	}
	var rels []ghRelease
	err = json.NewDecoder(resp.Body).Decode(&rels)
	resp.Body.Close()
	if resp.StatusCode != 200 || err != nil {
		return fmt.Errorf("GitHub said %s", resp.Status)
	}
	re := whisperAsset()
	for _, rel := range rels {
		for _, as := range rel.Assets {
			if !re.MatchString(as.Name) {
				continue
			}
			tmp := w.dir() + ".zip"
			defer os.Remove(tmp)
			if err := download(cl, as.URL, tmp, prog); err != nil {
				return err
			}
			log.Printf("whisper.cpp %s (%s)", rel.Tag, as.Name)
			return unzipFlat(tmp, w.dir())
		}
	}
	return fmt.Errorf("no whisper.cpp Windows build on GitHub right now")
}

// download saves url to dst through a .part file, passing on how far along it is.
func download(cl *http.Client, url, dst string, prog func(float64)) error {
	resp, err := cl.Get(url)
	if err != nil {
		return fmt.Errorf("couldn't download it, check the internet")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download: %s", resp.Status)
	}
	f, err := os.Create(dst + ".part")
	if err != nil {
		return err
	}
	var got int64
	buf := make([]byte, 1<<20)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, err = f.Write(buf[:n]); err != nil {
				break
			}
			got += int64(n)
			if resp.ContentLength > 0 {
				prog(float64(got) * 100 / float64(resp.ContentLength))
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			err = fmt.Errorf("the download stopped, try again")
			break
		}
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil && resp.ContentLength > 0 && got != resp.ContentLength {
		err = fmt.Errorf("the download stopped, try again")
	}
	if err != nil {
		os.Remove(dst + ".part")
		return err
	}
	return replaceFile(dst+".part", dst)
}

// unzipFlat puts every file of a zip straight into dir (the build keeps whisper-cli.exe and its DLLs in Release\).
func unzipFlat(archive, dir string) error {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer zr.Close()
	tmp := dir + ".new"
	os.RemoveAll(tmp)
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return err
	}
	for _, zf := range zr.File {
		if zf.FileInfo().IsDir() {
			continue
		}
		if err := unzipOne(zf, filepath.Join(tmp, filepath.Base(zf.Name))); err != nil {
			os.RemoveAll(tmp)
			return err
		}
	}
	if _, err := os.Stat(filepath.Join(tmp, "whisper-cli.exe")); err != nil {
		os.RemoveAll(tmp)
		return fmt.Errorf("whisper-cli.exe missing from the download")
	}
	os.RemoveAll(dir + ".old")
	os.Rename(dir, dir+".old")
	if err := os.Rename(tmp, dir); err != nil {
		return err
	}
	os.RemoveAll(dir + ".old")
	return nil
}

// ---------- the queue ----------

func NewTranscriber(ffmpeg func() string, dir func() string) *Converter {
	c := newQueue("transcripts.json", "tr-in", func(string) string { return ffmpeg() }, dir)
	c.work = c.trWork
	c.notify = func(j *CvJob) {
		notify("Transcribe", fmt.Sprintf("%s is ready as text.", trTitle(j)))
	}
	go c.worker()
	return c
}

func trTitle(j *CvJob) string {
	if len(j.Inputs) > 1 {
		return fmt.Sprintf("%s and %d more", j.Inputs[0], len(j.Inputs)-1)
	}
	return j.Inputs[0]
}

// TrCheck says why these files can't be transcribed, or "".
func TrCheck(names []string) string {
	if len(names) == 0 {
		return "No files came through."
	}
	for _, n := range names {
		if k := KindOf(n); k == nil || (k.ID != "video" && k.ID != "audio") {
			return filepath.Base(n) + " has no sound to transcribe. Pick a voice memo, a video or a sound file."
		}
	}
	return ""
}

// StartTr queues a job whose files are already in InputDir(id). target is "text", or "en" to translate.
func (c *Converter) StartTr(id string, names []string, target, from string) (*CvJob, string) {
	if why := TrCheck(names); why != "" {
		os.RemoveAll(c.InputDir(id))
		return nil, why
	}
	if target != "en" {
		target = "text"
	}
	return c.add(&CvJob{ID: id, Kind: "transcribe", Inputs: names, Target: target, From: from}), ""
}

// trWork gets the engine if needed, then makes a .txt and an .srt for each file.
func (c *Converter) trWork(ctx context.Context, j *CvJob, in, out string, prog0 func(float64)) (made, fails []string) {
	if !whisper.has(j.Target) {
		c.update(j.ID, func(j *CvJob) { j.Note = "Getting the speech engine first. It's a big download, only this once." })
		if err := whisper.Install(j.Target, prog0); err != nil {
			return nil, []string{"The speech engine couldn't be fetched: " + err.Error() + "."}
		}
		c.update(j.ID, func(j *CvJob) { j.Note, j.Pct = "", 0 })
	}
	var langs []string
	for i, n := range j.Inputs {
		prog := func(p float64) { prog0((float64(i) + p) * 100 / float64(len(j.Inputs))) }
		files, lang, err := c.transcribe(ctx, j.Target, filepath.Join(in, n), in, out, baseName(n), prog)
		if ctx.Err() != nil {
			return nil, nil
		}
		if err != nil {
			log.Printf("transcribe %s: %v", n, err)
			fails = append(fails, fmt.Sprintf("%s: %v.", n, err))
			continue
		}
		made = append(made, files...)
		if lang != "" && !strings.Contains(strings.Join(langs, ","), lang) {
			langs = append(langs, lang)
		}
	}
	c.update(j.ID, func(j *CvJob) { j.Lang = strings.Join(langs, ", ") })
	return made, fails
}

var (
	trProgRe = regexp.MustCompile(`progress =\s*(\d+)%`)
	trLangRe = regexp.MustCompile(`auto-detected language: (\w+)`)
)

// whisperArgs: the model, the 16 kHz sound, auto language, and both a .txt and an .srt named base.
func whisperArgs(model, wav, base, target string) []string {
	a := []string{"-m", model, "-f", wav, "-l", "auto", "-otxt", "-osrt", "-of", base, "-pp"}
	if target == "en" {
		a = append(a, "-tr")
	}
	return a
}

// transcribe turns one file into name.txt and name.srt in out, and says the language it heard.
func (c *Converter) transcribe(ctx context.Context, target, src, work, out, name string, prog func(float64)) ([]string, string, error) {
	ctx, stop := context.WithTimeout(ctx, 6*time.Hour)
	defer stop()
	// Whisper wants 16 kHz mono sound; FFmpeg pulls it out of any video or voice memo. Plain ASCII names here,
	// because whisper.cpp can't open Arabic file names on Windows.
	wav := filepath.Join(work, "sound.wav")
	defer os.Remove(wav)
	if err := runEngine(ctx, c.bin("ffmpeg"), []string{"-hide_banner", "-nostdin", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav}, nil); err != nil {
		return nil, "", err
	}
	prog(0.02)
	base := filepath.Join(work, "words")
	cmd := hidden(exec.CommandContext(ctx, whisper.Bin(), whisperArgs(whisper.Model(target), wav, base, target)...))
	var tail limitWriter
	tail.b, tail.n = &strings.Builder{}, 8<<10
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = io.Discard, pw
	if err := cmd.Start(); err != nil {
		return nil, "", fmt.Errorf("couldn't start the speech engine")
	}
	lang := ""
	done := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(pr)
		for sc.Scan() {
			l := sc.Text()
			tail.Write([]byte(l + "\n"))
			if m := trProgRe.FindStringSubmatch(l); m != nil {
				p, _ := strconv.Atoi(m[1])
				prog(0.02 + float64(p)/100*0.97)
			} else if m := trLangRe.FindStringSubmatch(l); m != nil {
				lang = langName(m[1])
			}
		}
		close(done)
	}()
	err := cmd.Wait()
	pw.Close()
	<-done
	if err != nil {
		if ctx.Err() != nil {
			return nil, "", ctx.Err()
		}
		return nil, "", fmt.Errorf("%s", engineError(tail.b.String()))
	}
	var files []string
	txt := freeName(out, name, "txt")
	srt := strings.TrimSuffix(txt, ".txt") + ".srt"
	for _, p := range [][2]string{{base + ".txt", txt}, {base + ".srt", srt}} {
		if err := os.Rename(p[0], p[1]); err != nil {
			if err := copyFile(p[0], p[1]); err != nil {
				return files, lang, fmt.Errorf("couldn't save the text")
			}
			os.Remove(p[0])
		}
		files = append(files, p[1])
	}
	if target == "en" {
		lang += " → English"
	}
	return files, strings.TrimPrefix(lang, " "), nil
}

var langNames = map[string]string{"ar": "Arabic", "en": "English", "fr": "French", "es": "Spanish", "de": "German",
	"tr": "Turkish", "ur": "Urdu", "hi": "Hindi", "fa": "Persian", "it": "Italian", "pt": "Portuguese", "ru": "Russian",
	"ja": "Japanese", "ko": "Korean", "zh": "Chinese", "id": "Indonesian", "nl": "Dutch"}

func langName(code string) string {
	if n := langNames[code]; n != "" {
		return n
	}
	return strings.ToUpper(code)
}
