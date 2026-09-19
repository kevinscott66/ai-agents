import SwiftUI
import WebKit
import UniformTypeIdentifiers

@MainActor final class PanelLoadState: ObservableObject {
    @Published var loading = true
    @Published var error: String?
}
struct PanelView: View {
    let server: String
    var onMacStart: ((String, String, String, Bool) throws -> Void)? = nil
    @StateObject private var state = PanelLoadState()
    @State private var generation = UUID()
    var body: some View {
        ZStack {
            PanelWebView(server: server, state: state, onMacStart: onMacStart).id(generation)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if state.loading { ProgressView("Открываем панель…").padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20)) }
            if let error = state.error {
                ContentUnavailableView {
                    Label("Панель не открылась", systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                } description: { Text(error) } actions: {
                    Button("Попробовать снова") { state.error = nil; state.loading = true; generation = UUID() }
                }.background(Color(uiColor: .systemBackground))
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle("Панель команды").navigationBarTitleDisplayMode(.inline)
            .background(Color(uiColor: .systemBackground))
    }
}
struct PanelWebView: UIViewRepresentable {
    let server: String
    @ObservedObject var state: PanelLoadState
    var onMacStart: ((String, String, String, Bool) throws -> Void)? = nil
    func makeCoordinator() -> Coordinator { Coordinator(server: server, state: state, onMacStart: onMacStart) }
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
        context.coordinator.entry = URL(string: entry)!
        // Begin after SwiftUI has inserted the web view into its navigation sheet.
        DispatchQueue.main.async { context.coordinator.load(view) }
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {}
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.cancel(); view.stopLoading(); view.configuration.userContentController.removeScriptMessageHandler(forName: "panel", contentWorld: .page)
        coordinator.cancel()
    }
    final class Coordinator: NSObject, WKURLSchemeHandler, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
        let server: String
        private var jobs: [UUID: Task<Void, Never>] = [:]
        let state: PanelLoadState
        var entry = URL(string: "agent-panel://bundle/index.html")!
        private var watchdog: Task<Void, Never>?
        private var closed = false
        let onMacStart: ((String, String, String, Bool) throws -> Void)?
        init(server: String, state: PanelLoadState, onMacStart: ((String, String, String, Bool) throws -> Void)?) { self.server = server; self.state = state; self.onMacStart = onMacStart }
        func load(_ view: WKWebView) {
            guard !closed else { return }
            view.load(URLRequest(url: entry))
            watchdog = Task { @MainActor [weak self, weak view] in
                try? await Task.sleep(for: .seconds(12))
                guard !Task.isCancelled, let self, !self.closed, self.state.loading else { return }
                view?.stopLoading()
                self.fail("Встроенная страница не запустилась. Повторите открытие панели. Если ошибка повторяется, установите последнюю сборку.")
            }
        }
        private func fail(_ text: String) { guard !closed else { return }; state.loading = false; state.error = text; watchdog?.cancel() }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail("Ошибка загрузки: " + error.localizedDescription) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail("Ошибка страницы: " + error.localizedDescription) }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail("iOS остановила панель. Нажмите «Попробовать снова».") }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript("document.getElementById('root')?.childElementCount > 0") { [weak self] value, error in
                guard let self, !self.closed else { return }
                if value as? Bool == true { self.state.loading = false; self.watchdog?.cancel() }
                // React's lazy imports may finish later; readiness also arrives via bridge.
            }
        }
        func cancel() { closed = true; watchdog?.cancel(); for task in jobs.values { task.cancel() }; jobs.removeAll() }
        func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
            guard let url = task.request.url, url.scheme == "agent-panel", url.host == "bundle",
                  let bundle = Bundle.main.resourceURL,
                  !url.path.contains("..") else { task.didFailWithError(URLError(.badURL)); return }
            let root = bundle.appendingPathComponent("Panel", isDirectory: true).standardizedFileURL
            let file = root.appendingPathComponent(String(url.path.dropFirst())).standardizedFileURL
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
            if !closed, message.frameInfo.isMainFrame, message.frameInfo.request.url?.scheme == "agent-panel", message.frameInfo.request.url?.host == "bundle",
               let input = message.body as? [String: Any], input["ready"] as? Bool == true {
                state.loading = false; watchdog?.cancel(); replyHandler(["ok": true], nil); return
            }
            if !closed, message.frameInfo.isMainFrame, message.frameInfo.request.url?.scheme == "agent-panel",
               message.frameInfo.request.url?.host == "bundle", let input = message.body as? [String: Any],
               let launch = input["macStart"] as? [String: Any] {
                do {
                    let request = try PanelMacLaunch(launch)
                    guard let onMacStart else { throw AgentError.message("Не удалось передать задачу в чат") }
                    try onMacStart(request.project, request.prompt, request.provider, request.allowFallback)
                    replyHandler(["ok": true], nil)
                }
                catch { replyHandler(nil, error.localizedDescription) }
                return
            }
            guard !closed, message.frameInfo.isMainFrame, message.frameInfo.request.url?.scheme == "agent-panel",
                  message.frameInfo.request.url?.host == "bundle", let input = message.body as? [String: Any],
                  let path = input["path"] as? String, let method = input["method"] as? String,
                  ["GET", "POST"].contains(method), jobs.count < 16 else { replyHandler(nil, "Запрос панели отклонён"); return }
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--dashboard-fixture"), method == "GET" {
                let names = ["Лид команды", "Планирование", "Продукт", "Backend", "Frontend", "Тестирование", "Аналитика", "Контроль качества", "Безопасность", "Контент", "Дизайн", "Проекты"]
                let agents = names.enumerated().map { ["key": "preview-" + String($0.offset), "title": $0.element, "provider": "internal", "execution_state": "running", "status": "running", "health": ["alive":true,"consecutiveFailures":0]] as [String: Any] }
                let value: [String: Any] = path.hasPrefix("/api/dashboard") ? ["counts": ["tasksPending":0,"approvalsPending":0,"actionsSince":0], "agents":agents,"recentActions":[],"budgets":[]] : path.hasPrefix("/api/autonomy") ? ["mode":"locked","admin":false] : ["mac_online":true,"actions":[]]
                let data = try! JSONSerialization.data(withJSONObject: value)
                replyHandler(["status":200,"body":String(data:data,encoding:.utf8)!], nil); return
            }
            #endif
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
        let allowed = ["/api/health", "/api/dashboard", "/api/agents", "/api/budgets", "/api/budget-settings", "/api/tasks", "/api/wiki/list", "/api/wiki/page", "/api/approvals", "/api/actions", "/api/permissions", "/api/autonomy", "/api/mac/stop", "/api/native/signing/key", "/api/native/signing/keys", "/api/native/signing/actions"]
        let dynamic = route.path.range(of: #"^/api/(native/conversations/[a-zA-Z0-9-]{16,64}/approvals|agents/[a-zA-Z0-9_-]+/(pause|resume)|tasks/[a-zA-Z0-9_-]+(/status)?|approvals/[a-zA-Z0-9_-]+/decide|native/signing/keys/[0-9a-f-]{36}/activate|native/signing/actions/[A-Za-z0-9_-]{43}/(approve|reject))$"#, options: .regularExpression) != nil
        guard allowed.contains(route.path) || dynamic else { throw AgentError.message("Раздел панели недоступен") }
        target.path = route.path; target.percentEncodedQuery = route.percentEncodedQuery
        guard let url = target.url else { throw AgentError.message("Недопустимый адрес панели") }; return url
    }
    static func request(server: String, path: String, method: String, body: String?, expectedToken: String? = nil) async throws -> [String: Any] {
        let url = try url(server: server, path: path)
        guard let token = Credentials.read(server: server) else { throw AgentError.message("Подключите iPhone в настройках приложения") }
        if let expectedToken, token != expectedToken { throw AgentError.message("Подключение изменилось. Обновите подтверждения.") }
        guard (body?.utf8.count ?? 0) <= 65536 else { throw AgentError.message("Запрос слишком большой") }
        var request = URLRequest(url: url); request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if method == "POST" { request.httpBody = body?.data(using: .utf8); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let config = URLSessionConfiguration.ephemeral; config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 12; config.timeoutIntervalForResource = 15
        var tunnel: Int?
        #if os(iOS)
        tunnel = try await FluxNetwork.configure(config)
        #endif
        let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let bytes: URLSession.AsyncBytes, response: URLResponse
        do { (bytes, response) = try await session.bytes(for: request) }
        catch where FluxNetwork.isTunnelFailure(error, generation: tunnel) {
            await FluxNetwork.dropTunnel(generation: tunnel)
            throw AgentError.message(method == "GET" ? "Сеть сменилась, OpenFlux переподключается. Обновите панель." : "Сеть сменилась, OpenFlux переподключается. Проверьте результат и повторите.")
        }
        guard let response = response as? HTTPURLResponse, response.expectedContentLength <= Int64(AgentAPI.maximumResponseBytes) else { throw AgentError.message("Ответ панели слишком большой") }
        let data = try await AgentAPI.readBody(bytes)
        return ["status": response.statusCode, "body": String(data: data, encoding: .utf8) ?? ""]
    }
}

struct PanelMacLaunch {
    let project: String
    let prompt: String
    let provider: String
    let allowFallback: Bool
    init(_ fields: [String: Any]) throws {
        let provider = fields["provider"] as? String ?? "claude"
        guard fields["provider"] == nil || fields["provider"] is String,
              ["claude", "codex"].contains(provider),
              let project = fields["project"] as? String,
              let prompt = fields["prompt"] as? String,
              !project.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, project.count <= 500,
              !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, prompt.count <= 4000,
              fields["allowFallback"] == nil || (fields["allowFallback"] as? NSNumber).map({ String(cString: $0.objCType) == "c" }) == true
        else { throw AgentError.message("Недопустимые параметры сессии") }
        self.project = project; self.prompt = prompt; self.provider = provider
        self.allowFallback = provider == "claude" && (fields["allowFallback"] as? Bool ?? false)
    }
    static func draft(project: String, prompt: String, provider: String, allowFallback: Bool) -> String {
        let policy = allowFallback
            ? "Другой исполнитель разрешён только если выбранный недоступен до начала выполнения; после начала выполнения не повторяй задачу другим исполнителем."
            : "Не заменяй исполнителя."
        return "Запусти рабочую сессию на моём Mac через MAC_RUN_CLAUDE. Первый исполнитель: \(provider). Передай provider=\(provider), allowFallback=\(allowFallback ? "true" : "false") в MAC_RUN_CLAUDE. \(policy) Проект: \(project). Задача: \(prompt)"
    }
}
