import SwiftUI
import WebKit
import UniformTypeIdentifiers

struct PanelView: View {
    let server: String
    var body: some View {
        PanelWebView(server: server).navigationTitle("Панель команды")
            .navigationBarTitleDisplayMode(.inline).background(Color(uiColor: .systemBackground))
    }
}
struct PanelWebView: UIViewRepresentable {
    let server: String
    func makeCoordinator() -> Coordinator { Coordinator(server: server) }
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(context.coordinator, forURLScheme: "agent-panel")
        config.userContentController.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "panel")
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator; view.uiDelegate = context.coordinator
        view.isOpaque = false; view.backgroundColor = .systemBackground; view.scrollView.backgroundColor = .systemBackground
        var entry = "agent-panel://bundle/index.html"
        #if DEBUG
        if let tab = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--panel-tab=") })?.split(separator: "=").last,
           ["dashboard", "tasks", "approvals", "agents", "perms", "logs", "wiki", "settings", "mac"].contains(String(tab)) { entry += "#" + tab }
        #endif
        view.load(URLRequest(url: URL(string: entry)!))
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {}
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading(); view.configuration.userContentController.removeScriptMessageHandler(forName: "panel", contentWorld: .page)
        coordinator.cancel()
    }
    final class Coordinator: NSObject, WKURLSchemeHandler, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
        let server: String
        private var jobs: [UUID: Task<Void, Never>] = [:]
        init(server: String) { self.server = server }
        func cancel() { for task in jobs.values { task.cancel() }; jobs.removeAll() }
        func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
            guard let url = task.request.url, url.scheme == "agent-panel", url.host == "bundle",
                  let root = Bundle.main.resourceURL?.appendingPathComponent("Panel", isDirectory: true),
                  !url.path.contains("..") else { task.didFailWithError(URLError(.badURL)); return }
            let file = root.appendingPathComponent(url.path).standardizedFileURL
            guard file.path.hasPrefix(root.path + "/"), ["html", "js", "css", "svg", "png", "woff2"].contains(file.pathExtension),
                  let data = try? Data(contentsOf: file) else { task.didFailWithError(URLError(.fileDoesNotExist)); return }
            let mime = file.pathExtension == "js" ? "text/javascript" : UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: "utf-8"))
            task.didReceive(data); task.didFinish()
        }
        func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let url = action.request.url
            if url?.scheme == "agent-panel", url?.host == "bundle", url?.path == "/index.html" { decisionHandler(.allow); return }
            decisionHandler(.cancel)
            if action.navigationType == .linkActivated, let url, url.scheme == "https" { UIApplication.shared.open(url) }
        }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
            guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.scheme == "agent-panel",
                  message.frameInfo.request.url?.host == "bundle", let input = message.body as? [String: Any],
                  let path = input["path"] as? String, let method = input["method"] as? String,
                  ["GET", "POST"].contains(method), jobs.count < 16 else { replyHandler(nil, "Запрос панели отклонён"); return }
            let body = input["body"] as? String; let id = UUID()
            jobs[id] = Task { @MainActor in
                defer { jobs.removeValue(forKey: id) }
                do {
                    let result = try await PanelTransport.request(server: server, path: path, method: method, body: body)
                    try Task.checkCancellation(); replyHandler(result, nil)
                } catch { replyHandler(nil, error.localizedDescription) }
            }
        }
        private func present(_ alert: UIAlertController, in webView: WKWebView) {
            var controller = webView.window?.rootViewController
            while let presented = controller?.presentedViewController { controller = presented }
            controller?.present(alert, animated: true)
        }
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let alert = UIAlertController(title: "Агент", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Понятно", style: .default) { _ in completionHandler() }); present(alert, in: webView)
        }
        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            let alert = UIAlertController(title: "Подтвердить действие", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "Подтвердить", style: .default) { _ in completionHandler(true) }); present(alert, in: webView)
        }
    }
}
enum PanelTransport {
    static func url(server: String, path: String) throws -> URL {
        guard var target = URLComponents(string: server), target.scheme == "https", target.host != nil,
              target.user == nil, target.password == nil, target.query == nil, target.fragment == nil,
              target.path.isEmpty || target.path == "/", let route = URLComponents(string: path),
              route.scheme == nil, route.host == nil, route.fragment == nil, route.path.hasPrefix("/api/"),
              !route.path.contains(".."), !route.path.contains("\\"), !route.path.contains("%") else { throw AgentError.message("Недопустимый адрес панели") }
        let allowed = ["/api/health", "/api/dashboard", "/api/agents", "/api/budgets", "/api/budget-settings", "/api/tasks", "/api/wiki/list", "/api/wiki/page", "/api/approvals", "/api/actions", "/api/permissions", "/api/autonomy", "/api/mac/stop"]
        let dynamic = route.path.range(of: #"^/api/(agents/[a-zA-Z0-9_-]+/(pause|resume)|tasks/[a-zA-Z0-9_-]+(/status)?|approvals/[a-zA-Z0-9_-]+/decide)$"#, options: .regularExpression) != nil
        guard allowed.contains(route.path) || dynamic else { throw AgentError.message("Раздел панели недоступен") }
        target.path = route.path; target.percentEncodedQuery = route.percentEncodedQuery
        guard let url = target.url else { throw AgentError.message("Недопустимый адрес панели") }; return url
    }
    static func request(server: String, path: String, method: String, body: String?) async throws -> [String: Any] {
        let url = try url(server: server, path: path)
        guard let token = Credentials.read(server: server) else { throw AgentError.message("Подключите iPhone в настройках приложения") }
        guard (body?.utf8.count ?? 0) <= 65536 else { throw AgentError.message("Запрос слишком большой") }
        var request = URLRequest(url: url); request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if method == "POST" { request.httpBody = body?.data(using: .utf8); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let config = URLSessionConfiguration.ephemeral; config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 12; config.timeoutIntervalForResource = 15
        let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse, response.expectedContentLength <= Int64(AgentAPI.maximumResponseBytes) else { throw AgentError.message("Ответ панели слишком большой") }
        let data = try await AgentAPI.readBody(bytes)
        return ["status": response.statusCode, "body": String(data: data, encoding: .utf8) ?? ""]
    }
}
