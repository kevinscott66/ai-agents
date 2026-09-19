import Foundation
import Network
import Security
import SwiftUI

struct FluxSettings: Codable, Equatable {
    var enabled = false
    var transport = "yandex"
    var document = ""
    static let key = "local.openflux.configuration.v1"

    func validate() throws {
        guard enabled else { return }
        if transport == "yandex" {
            guard let url = URLComponents(string: document), url.scheme == "https",
                  let host = url.host?.lowercased(), host == "docs.yandex.ru" || host == "disk.yandex.ru",
                  url.user == nil, url.password == nil, url.port == nil,
                  document.utf8.count <= 4096 else {
                throw AgentError.message("Укажите HTTPS-ссылку на документ Яндекса")
            }
        } else { throw AgentError.message("Неизвестный транспорт OpenFlux") }
    }
    static func load() throws -> FluxSettings {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--openflux-probe"),
           let document = ProcessInfo.processInfo.environment["AGENT_TEST_FLUX_DOCUMENT"] {
            var test = FluxSettings(); test.enabled = true; test.document = document
            return test
        }
        #endif
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "tech.dobropalm.agent", kSecAttrAccount as String: key,
            kSecReturnData as String: true]
        var item: CFTypeRef?
        let result = SecItemCopyMatching(query as CFDictionary, &item)
        if result == errSecItemNotFound { return FluxSettings() }
        guard result == errSecSuccess, let data = item as? Data else {
            throw AgentError.message("Разблокируйте iPhone для доступа к настройкам OpenFlux")
        }
        guard let value = try? JSONDecoder().decode(Self.self, from: data) else {
            throw AgentError.message("Настройки OpenFlux повреждены. Сохраните их заново.")
        }
        return value
    }
    func toggled() throws -> FluxSettings {
        var next = self
        next.enabled.toggle()
        try next.validate()
        return next
    }
    func save() throws {
        try validate()
        let data = try JSONEncoder().encode(self)
        try Credentials.save(String(decoding: data, as: UTF8.self), server: Self.key)
        NotificationCenter.default.post(name: Notification.Name("agent.openflux.settingsChanged"), object: nil)
    }
}

/// All C runtime transitions are serialized off the UI thread. Never retries HTTP mutations.
/// Смена сети (VPN, Wi‑Fi ↔ сотовая, другой оператор) рвёт соединения туннеля:
/// монитор пути гасит его, и следующий запрос поднимает туннель заново.
enum FluxNetwork {
    private static let queue = DispatchQueue(label: "agent.openflux.runtime", qos: .userInitiated)
    // Access only on queue.
    private static var active: FluxSettings?
    private static var endpoint: NWEndpoint?
    private static var generation = 0
    private static var monitor: NWPathMonitor?
    private static var pathSignature: String?

    /// Returns the tunnel generation used for this configuration, or nil for a direct connection.
    @discardableResult
    static func configure(_ configuration: URLSessionConfiguration) async throws -> Int? {
        let prepared: (NWEndpoint, Int)? = try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do { continuation.resume(returning: try prepare()) }
                catch { continuation.resume(throwing: error) }
            }
        }
        try Task.checkCancellation()
        guard let (proxy, used) = prepared else { return nil }
        var setting = ProxyConfiguration(socksv5Proxy: proxy)
        setting.allowFailover = false
        configuration.proxyConfigurations = [setting]
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 90
        return used
    }

    /// Transport-level failure of a proxied request: the tunnel is likely dead after a network change.
    static func isTunnelFailure(_ error: Error, generation used: Int?) -> Bool {
        guard used != nil, let error = error as? URLError else { return false }
        return [.networkConnectionLost, .cannotConnectToHost, .timedOut, .notConnectedToInternet,
                .secureConnectionFailed, .cannotFindHost, .dnsLookupFailed, .cannotLoadFromNetwork].contains(error.code)
    }

    /// Drops the tunnel only if nobody has restarted it since `used` was handed out.
    static func dropTunnel(generation used: Int?) async {
        guard let used else { return }
        await withCheckedContinuation { continuation in
            queue.async {
                if used == generation { stopTunnel() }
                continuation.resume()
            }
        }
    }

    // Queue only. Keeps `active`, so the next request restarts the same settings.
    private static func stopTunnel() {
        if endpoint != nil { OpenFluxStop() }
        endpoint = nil
        generation += 1
    }

    // Queue only.
    private static func watchPath() {
        guard monitor == nil else { return }
        let watcher = NWPathMonitor()
        watcher.pathUpdateHandler = { path in
            let signature = "\(path.status)|" + path.availableInterfaces.map { "\($0.type)-\($0.name)" }.joined(separator: ",")
                + "|\(path.isExpensive)|\(path.isConstrained)"
            if let previous = pathSignature, previous != signature { stopTunnel() }
            pathSignature = signature
        }
        watcher.start(queue: queue)
        monitor = watcher
    }

    private static func prepare() throws -> (NWEndpoint, Int)? {
        let settings = try FluxSettings.load()
        try settings.validate()
        if settings != active {
            stopTunnel()
            active = nil
        }
        guard settings.enabled else { return nil }
        watchPath()
        if let endpoint { return (endpoint, generation) }
        let values = [settings.transport, settings.document, "", "", "127.0.0.1:0", "1.1.1.1:53"]
        let arguments = values.map { strdup($0) }
        defer { arguments.forEach { free($0) } }
        guard arguments.allSatisfy({ $0 != nil }) else { throw AgentError.message("Не хватает памяти для OpenFlux") }
        // Сразу после смены сети интерфейс ещё поднимается: старт туннеля
        // (не HTTP-запрос к серверу) безопасно повторить с паузой.
        var started = false
        for delay in [0.0, 0.5, 1.5] {
            if delay > 0 { Thread.sleep(forTimeInterval: delay) }
            if let error = OpenFluxStart(arguments[0], arguments[1], arguments[2], arguments[3], arguments[4], arguments[5]) {
                OpenFluxFree(error) // Raw transport errors can contain private document URLs or tokens.
                OpenFluxStop()
                continue
            }
            started = true; break
        }
        guard started else { throw AgentError.message("OpenFlux не подключился. Проверьте сеть, настройки и доступность выходной ноды.") }
        guard let raw = OpenFluxSocksAddr() else {
            OpenFluxStop()
            throw AgentError.message("OpenFlux не создал локальное соединение")
        }
        let address = String(cString: raw); OpenFluxFree(raw)
        guard address.hasPrefix("127.0.0.1:"), let number = UInt16(address.dropFirst("127.0.0.1:".count)),
              number > 0, let port = NWEndpoint.Port(rawValue: number) else {
            OpenFluxStop()
            throw AgentError.message("OpenFlux вернул некорректный локальный адрес")
        }
        let result = NWEndpoint.hostPort(host: "127.0.0.1", port: port)
        active = settings; endpoint = result; generation += 1
        return (result, generation)
    }

    static func reset() async {
        await withCheckedContinuation { continuation in
            queue.async {
                stopTunnel(); OpenFluxStop(); active = nil
                continuation.resume()
            }
        }
    }
}

struct OpenFluxQuickToggle: View {
    let server: String
    @Environment(\.scenePhase) private var scenePhase
    @State private var enabled = false
    @State private var busy = false
    @State private var configure = false
    @State private var failure: String?
    var body: some View {
        Button {
            Task { @MainActor in
                guard !busy else { return }
                busy = true
                defer { busy = false }
                do {
                    let current = try FluxSettings.load()
                    let next: FluxSettings
                    do { next = try current.toggled() }
                    catch { configure = true; return }
                    try next.save()
                    enabled = next.enabled
                    await FluxNetwork.reset()
                } catch { failure = error.localizedDescription }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: enabled ? "power.circle.fill" : "power.circle")
                Text("OF").font(.caption.weight(.semibold))
            }.frame(minWidth: 44, minHeight: 44)
        }.disabled(busy)
            .accessibilityLabel(enabled ? "OpenFlux включён. Выключить" : "OpenFlux выключен. Включить")
            .task(id: scenePhase) { if scenePhase == .active { reload() } }
            .onReceive(NotificationCenter.default.publisher(for: Notification.Name("agent.openflux.settingsChanged"))) { _ in reload() }
            .sheet(isPresented: $configure, onDismiss: reload) {
                NavigationStack {
                    OpenFluxSettingsView(server: server)
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { configure = false } } }
                }
            }
            .alert("OpenFlux", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
                Button("Понятно") { failure = nil }
            } message: { Text(failure ?? "") }
    }
    private func reload() {
        do { enabled = try FluxSettings.load().enabled }
        catch { failure = error.localizedDescription }
    }
}

struct OpenFluxSettingsView: View {
    private static var notices: String {
        ["LICENSE", "NOTICE"].compactMap { name in
            guard let url = Bundle.main.url(forResource: name, withExtension: nil, subdirectory: "OpenFluxNotices") else { return nil }
            return try? String(contentsOf: url, encoding: .utf8)
        }.joined(separator: "\n\n")
    }
    let server: String
    @State private var draft = FluxSettings()
    @State private var status = ""
    @State private var busy = false
    var body: some View {
        Form {
            Section {
                Toggle("Подключаться через OpenFlux", isOn: $draft.enabled)
                Text("Чат и панель команды используют ваш туннель. Автоматического перехода на прямое соединение нет.").font(.footnote).foregroundStyle(.secondary)
            }
            Section("Транспорт") {
                Text("Яндекс Документы")
                SecureField("Ссылка на документ", text: $draft.document).keyboardType(.URL)
                Text("Нужен документ, к которому подключена ваша выходная нода OpenFlux.").font(.footnote).foregroundStyle(.secondary)
            }.textInputAutocapitalization(.never).autocorrectionDisabled()
            Section {
                Button("Сохранить и проверить") {
                    busy = true; status = "Проверяем соединение с сервером…"
                    Task {
                        do {
                            try draft.save()
                            await FluxNetwork.reset()
                            try await AgentAPI(server: server).checkConnection()
                            status = draft.enabled ? "Сервер доступен через OpenFlux" : "Сервер доступен напрямую"
                        } catch { status = error.localizedDescription }
                        busy = false
                    }
                }
                if busy { ProgressView() }
                if !status.isEmpty { Text(status).font(.footnote) }
            }
            Section {
                Text("Данные транспорта хранятся в Keychain этого iPhone. Работа при белых списках зависит от доступности выбранного сервиса в вашей сети. Другие приложения, такси и банк используют собственное соединение.").font(.footnote).foregroundStyle(.secondary)
                NavigationLink("Лицензия OpenFlux") {
                    ScrollView {
                        Text(Self.notices)
                            .font(.caption).textSelection(.enabled).padding()
                    }.navigationTitle("OpenFlux · GPLv3")
                }
            }
        }.disabled(busy).navigationTitle("OpenFlux")
            .interactiveDismissDisabled(busy)
            .onAppear { do { draft = try FluxSettings.load() } catch { status = error.localizedDescription } }
    }
}

#if DEBUG
struct OpenFluxProbeView: View {
    @State private var result = "Проверяем OpenFlux…"
    var body: some View {
        Text(result).padding().task {
            do {
                let server = UserDefaults.standard.string(forKey: "server") ?? ""
                guard !server.isEmpty else { throw AgentError.message("Сначала подключите устройство к серверу") }
                try await AgentAPI(server: server).checkConnection()
                result = "PASS: HTTPS health through OpenFlux"
            } catch { result = "FAIL: " + error.localizedDescription }
            let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("openflux-probe.txt")
            try? Data(result.utf8).write(to: url, options: .atomic)
            await FluxNetwork.reset()
        }
    }
}
#endif
