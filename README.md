# Premade Tools

Rayan's own tools, in Premade's look. First tool: **Vault**, which saves every file deleted from your phones to your PC.

- `bintest/`: one-screen Android test that checks a normal app can read Samsung's Recycle bin (`Android/.Trash`) and Android's trash. Built by the "Bin test APK" workflow.
- `pc/`: the Windows program (Go, one exe). Keeps deleted files in the vault folder the user picks, pairs phones by QR code, and shows its screens in an Edge app window. Build: `cd pc && GOOS=windows go build -ldflags "-H=windowsgui -s -w" -o PremadeTools.exe .` Test: `go test ./...`
