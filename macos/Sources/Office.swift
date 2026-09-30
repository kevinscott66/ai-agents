import SwiftUI
import WebKit

@MainActor final class OfficeState: ObservableObject {
    @Published var message = ""
    @Published var loading = true
    weak var webView: WKWebView?
    func reload() { message = ""; loading = true; webView?.reload() }
}
struct OfficeBrowser: NSViewRepresentable {
    let server: String
    let token: String
    @ObservedObject var state: OfficeState
    func makeCoordinator() -> Coordinator { Coordinator(state,server:server) }
    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // The native Keychain remains the only persistent credential store.
        config.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        state.webView = view
        context.coordinator.connect(view, token:token)
        return view
    }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.stop()
        view.stopLoading(); view.navigationDelegate = nil; view.uiDelegate = nil
        view.loadHTMLString("", baseURL: nil)
    }
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let state: OfficeState
        let root: URL?
        private let server: String
        private var active = true
        init(_ state: OfficeState,server:String) { self.state = state;self.server=server;self.root = try? secureServer(server) }
        func stop() { active=false }
        func connect(_ view:WKWebView,token:String) {
            Task { @MainActor [weak self,weak view] in
                guard let self,let view,self.active else{return}
                guard let root=self.root,let cookie=officeSessionCookie(server:root,token:token) else {
                    self.state.loading=false;self.state.message="Сначала подключите приложение в разделе «Подключение».";return
                }
                // This view and its ephemeral store belong to exactly one credential.
                await view.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
                guard self.active,Vault.read(self.server)==token else{return}
                self.state.loading=true;self.state.message=""
                view.load(URLRequest(url:root.appendingPathComponent("office/")))
            }
        }
        func trusted(_ url:URL)->Bool { guard let root else{return false};return officeTrustedURL(url,root:root) }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard active else {decisionHandler(.cancel);return}
            guard let url = action.request.url else { decisionHandler(.cancel); return }
            let internalURL = trusted(url)
            if internalURL { decisionHandler(.allow); return }
            if action.navigationType == .linkActivated, ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if active, let url = action.request.url, trusted(url) { webView.load(action.request) }
            return nil
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { guard active else{return};state.loading = false; state.message = "" }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { guard active else{return};state.loading = false; state.message = "Окно офиса было остановлено. Нажмите «Обновить»." }
        private func failed(_ error: Error) {
            guard active else{return}
            if (error as NSError).code == NSURLErrorCancelled { return }
            state.loading = false; state.message = "Не удалось открыть офис. Проверьте подключение и повторите попытку."
        }
    }
}
struct OfficeWindow: View {
    let server:String
    @StateObject private var state = OfficeState()
    @State private var credential = ""
    @State private var credentialServer = ""
    var body: some View {
        VStack(spacing: 0) {
            if state.loading { ProgressView().controlSize(.small).padding(8) }
            if !state.message.isEmpty { HStack { Text(state.message); Button("Повторить") { state.reload() } }.padding() }
            if credentialServer == server && !credential.isEmpty {
                OfficeBrowser(server:server,token:credential,state:state).id(server + "|" + credential)
            } else { Text("Подключите приложение в разделе «Подключение».").padding() }
        }
        .task(id:server) {
            while !Task.isCancelled {
                credential=Vault.read(server);credentialServer=server
                if credential.isEmpty {state.loading=false}
                do {try await Task.sleep(for:.seconds(2))} catch {break}
            }
        }
        .frame(minWidth: 760, minHeight: 540)
        .toolbar { Button { state.reload() } label: { Label("Обновить", systemImage: "arrow.clockwise") } }
    }
}
