import AppKit
import WebKit

private let defaultAppURL = "https://10.1.0.10/"

private final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
  private let startURL: URL
  private var window: NSWindow?
  private var webView: WKWebView?
  private var keyMonitor: Any?

  init(startURL: URL) {
    self.startURL = startURL
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildMenu()
    showAppWindow(loadIfNeeded: true)

    keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      guard self?.handleKeyDown(event) == true else {
        return event
      }
      return nil
    }

    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationWillTerminate(_ notification: Notification) {
    if let keyMonitor {
      NSEvent.removeMonitor(keyMonitor)
    }
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    showAppWindow(loadIfNeeded: webView == nil)
    return true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  private func buildMenu() {
    let mainMenu = NSMenu()

    let appMenuItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(NSMenuItem(title: "Quit AI Workflow", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    appMenuItem.submenu = appMenu
    mainMenu.addItem(appMenuItem)

    let viewMenuItem = NSMenuItem()
    let viewMenu = NSMenu(title: "View")

    let jumpItem = NSMenuItem(title: "Terminal Switcher", action: #selector(openTerminalSwitcher(_:)), keyEquivalent: "\r")
    jumpItem.keyEquivalentModifierMask = [.command]
    jumpItem.target = self
    viewMenu.addItem(jumpItem)

    let reloadItem = NSMenuItem(title: "Reload", action: #selector(reloadPage(_:)), keyEquivalent: "r")
    reloadItem.keyEquivalentModifierMask = [.command]
    reloadItem.target = self
    viewMenu.addItem(reloadItem)

    let homeItem = NSMenuItem(title: "Home", action: #selector(loadHome(_:)), keyEquivalent: "0")
    homeItem.keyEquivalentModifierMask = [.command]
    homeItem.target = self
    viewMenu.addItem(homeItem)

    viewMenuItem.submenu = viewMenu
    mainMenu.addItem(viewMenuItem)

    NSApp.mainMenu = mainMenu
  }

  private func buildWindow() {
    let configuration = WKWebViewConfiguration()
    let preferences = WKWebpagePreferences()
    preferences.allowsContentJavaScript = true
    configuration.defaultWebpagePreferences = preferences

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = true
    if #available(macOS 13.3, *) {
      webView.isInspectable = true
    }

    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1440, height: 940),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.title = "AI Workflow"
    window.minSize = NSSize(width: 1040, height: 680)
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.contentView = webView
    window.center()
    window.makeKeyAndOrderFront(nil)

    self.window = window
    self.webView = webView
  }

  private func showAppWindow(loadIfNeeded: Bool = false) {
    if window == nil || webView == nil {
      buildWindow()
      loadStartURL()
    } else {
      window?.makeKeyAndOrderFront(nil)
      if loadIfNeeded, webView?.url == nil {
        loadStartURL()
      }
    }

    NSApp.activate(ignoringOtherApps: true)
  }

  private func loadStartURL() {
    webView?.load(URLRequest(url: startURL))
  }

  private func handleKeyDown(_ event: NSEvent) -> Bool {
    let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    let isReturn = event.keyCode == 36 || event.keyCode == 76
    let hasSwitcherModifier = modifiers.contains(.command) || modifiers.contains(.control)
    guard isReturn && hasSwitcherModifier else {
      return false
    }

    dispatchTerminalSwitcherShortcut(
      command: modifiers.contains(.command),
      control: modifiers.contains(.control)
    )
    return true
  }

  private func dispatchTerminalSwitcherShortcut(command: Bool, control: Bool) {
    let script = """
    (() => {
      const target = document.activeElement || document.body || document;
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
        metaKey: \(command ? "true" : "false"),
        ctrlKey: \(control ? "true" : "false")
      });
      target.dispatchEvent(event);
    })();
    """
    webView?.evaluateJavaScript(script)
  }

  @objc private func openTerminalSwitcher(_ sender: Any?) {
    dispatchTerminalSwitcherShortcut(command: true, control: false)
  }

  @objc private func reloadPage(_ sender: Any?) {
    webView?.reload()
  }

  @objc private func loadHome(_ sender: Any?) {
    loadStartURL()
  }

  func webView(
    _ webView: WKWebView,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    let protectionSpace = challenge.protectionSpace
    guard
      protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      protectionSpace.host == startURL.host,
      let serverTrust = protectionSpace.serverTrust
    else {
      completionHandler(.performDefaultHandling, nil)
      return
    }

    completionHandler(.useCredential, URLCredential(trust: serverTrust))
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard
      navigationAction.navigationType == .linkActivated,
      let url = navigationAction.request.url,
      let host = url.host,
      host != startURL.host
    else {
      decisionHandler(.allow)
      return
    }

    NSWorkspace.shared.open(url)
    decisionHandler(.cancel)
  }

  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if navigationAction.targetFrame == nil {
      webView.load(navigationAction.request)
    }
    return nil
  }
}

private func resolveStartURL() -> URL {
  let environmentURL = ProcessInfo.processInfo.environment["AI_WORKFLOW_URL"]
  let argumentURL = CommandLine.arguments.dropFirst().first
  let rawURL = environmentURL ?? argumentURL ?? defaultAppURL

  guard let url = URL(string: rawURL), url.scheme != nil, url.host != nil else {
    fputs("Invalid AI Workflow URL: \(rawURL)\n", stderr)
    exit(64)
  }

  return url
}

let app = NSApplication.shared
private let delegate = AppDelegate(startURL: resolveStartURL())
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
