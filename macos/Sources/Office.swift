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
    @ObservedObject var state: OfficeState
    func makeCoordinator() -> Coordinator { Coordinator(state,server:server) }
    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        state.webView = view
        if let root = try? secureServer(server) { view.load(URLRequest(url:root.appendingPathComponent("office/"))) } else { DispatchQueue.main.async { state.loading=false;state.message="Укажите сервер в разделе «Подключение»" } }
        return view
    }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading(); view.navigationDelegate = nil; view.uiDelegate = nil
        view.loadHTMLString("", baseURL: nil)
    }
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let state: OfficeState
        let root: URL?
        init(_ state: OfficeState,server:String) { self.state = state;self.root = try? secureServer(server) }
        func trusted(_ url:URL)->Bool {url.scheme == "https" && url.host == root?.host && url.port == root?.port}
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { decisionHandler(.cancel); return }
            let internalURL = trusted(url)
            if internalURL { decisionHandler(.allow); return }
            if action.navigationType == .linkActivated, ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url, trusted(url) { webView.load(action.request) }
            return nil
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { state.loading = false; state.message = "" }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { state.loading = false; state.message = "Окно офиса было остановлено. Нажмите «Обновить»." }
        private func failed(_ error: Error) {
            if (error as NSError).code == NSURLErrorCancelled { return }
            state.loading = false; state.message = "Не удалось открыть офис. Проверьте подключение и повторите попытку."
        }
    }
}
struct OfficeWindow: View {
    let server:String
    @StateObject private var state = OfficeState()
    var body: some View {
        VStack(spacing: 0) {
            if state.loading { ProgressView().controlSize(.small).padding(8) }
            if !state.message.isEmpty { HStack { Text(state.message); Button("Повторить") { state.reload() } }.padding() }
            OfficeBrowser(server:server,state: state)
        }
        .frame(minWidth: 760, minHeight: 540)
        .toolbar { Button { state.reload() } label: { Label("Обновить", systemImage: "arrow.clockwise") } }
    }
}
