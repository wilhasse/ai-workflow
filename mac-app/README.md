# AI Workflow macOS App

This is a small native macOS wrapper around the existing AI Workflow dashboard on the Linux control host.

It opens `https://10.1.0.10/` in an AppKit/WKWebView window, accepts the host's local HTTPS certificate, and keeps the terminal switcher available with `Cmd+Enter` or `Ctrl+Enter`.

## Build and Open

```bash
./mac-app/build-ai-workflow-app.sh --open
```

The app bundle is created at:

```bash
mac-app/dist/AI Workflow.app
```

To point the app at another control host:

```bash
open "mac-app/dist/AI Workflow.app" --args https://10.1.0.10/
```

or run the binary directly with a URL or `AI_WORKFLOW_URL`:

```bash
"mac-app/dist/AI Workflow.app/Contents/MacOS/AiWorkflowNative" https://10.1.0.10/
AI_WORKFLOW_URL=https://10.1.0.10/ "mac-app/dist/AI Workflow.app/Contents/MacOS/AiWorkflowNative"
```
