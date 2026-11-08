# Premade Tools

Rayan's own tools, in Premade's look. Tools: **Vault** saves every file deleted from your phones to your PC, the **Downloader** saves videos and posts from any link, and the **Converter** turns pictures (iPhone HEIC too), videos, sound and office files into other formats on the PC, sending results back to the phone that asked. **PDF tools** merge, split, reorder, turn and delete pages, compress, and add or remove passwords (pdfcpu built in; Ghostscript, installed on first compress, for scans). **Transcribe** turns voice memos and videos into text and .srt subtitles with Whisper (whisper.cpp) on the PC's graphics card, fetched on first use; nothing goes online. **File drop** sends files, links and copied text between the PC and the paired phones (phone to phone through the PC), and keeps the clipboard in sync.

- `android/`: the Android app (Java). Watches Samsung's Recycle bin and Android's trash, sends new deletes to the PC, restores files, updates itself from the PC.
- `bintest/`: one-screen Android test that checks a normal app can read Samsung's Recycle bin (`Android/.Trash`) and Android's trash. Built by the "Bin test APK" workflow.
- `pc/`: the Windows program (Go, one exe). Keeps deleted files in the vault folder the user picks, pairs phones by QR code, and shows its screens in an Edge app window. Build: `cd pc && GOOS=windows go build -ldflags "-H=windowsgui -s -w" -o PremadeTools.exe .` Test: `go test ./...`

Each push to the default branch builds both and publishes a GitHub release; the PC program updates itself from the latest release and hands the newest Android app to paired phones. The Android signing key comes from the `ANDROID_KEYSTORE` secret (base64 PKCS12).
