import Foundation
import Security

struct Turn: Codable {
    let id: String
    let status: String
    let replies: [String]
    func validated(for requestedID: String) throws -> Turn {
        guard id == requestedID, ["running", "done", "error", "interrupted"].contains(status),
              replies.count <= 80, replies.allSatisfy({ $0.utf16.count <= 8_000 }) else {
            throw AgentError.message("Некорректный ответ сервера. Ожидание запроса сохранено.")
        }
        return self
    }
}
struct Pairing: Decodable {
    let token: String
    let userId: String
    func validatedToken() throws -> String {
        guard token.utf8.count == 64, token.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw AgentError.message("Сервер вернул некорректный ключ устройства")
        }
        return token
    }
}
enum AgentError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
struct Credentials {
    static func save(_ token: String, server: String) throws {
        let key: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "tech.dobropalm.agent", kSecAttrAccount as String: server]
        let attributes: [String: Any] = [kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(key as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let item = key.merging(attributes) { _, new in new }
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw AgentError.message("Не удалось сохранить ключ устройства") }
    }
    static func read(server: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "tech.dobropalm.agent", kSecAttrAccount as String: server, kSecReturnData as String: true]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func delete(server: String) {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "tech.dobropalm.agent", kSecAttrAccount as String: server] as CFDictionary)
    }
}
struct AgentAPI {
    let server: String
    static let maximumResponseBytes = 4 * 1_024 * 1_024
    static func readBody<S: AsyncSequence>(_ bytes: S) async throws -> Data where S.Element == UInt8 {
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < maximumResponseBytes else { throw AgentError.message("Ответ сервера слишком большой") }
            data.append(byte)
        }
        return data
    }
    private func request<T: Decodable>(_ path: String, body: [String: String]? = nil, authenticated: Bool = true) async throws -> T {
        guard var parts = URLComponents(string: server), parts.scheme == "https", parts.host != nil,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else { throw AgentError.message("Укажите HTTPS-адрес сервера без пути") }
        parts.path = path
        guard let url = parts.url else { throw AgentError.message("Некорректный адрес") }
        var request = URLRequest(url: url)
        request.timeoutInterval = 25
        if authenticated {
            guard let token = Credentials.read(server: server) else { throw AgentError.message("Подключите устройство в настройках") }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.timeoutIntervalForResource = 30
        let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw AgentError.message(code == 401 ? "Код или ключ недействителен. Подключите устройство заново." : code == 409 ? "Лид уже выполняет запрос. Дождитесь результата." : code == 503 ? "Лид или доступ приложения пока недоступен." : "Сервер вернул ошибку \(code)")
        }
        guard response.expectedContentLength <= Int64(Self.maximumResponseBytes) else {
            throw AgentError.message("Ответ сервера слишком большой")
        }
        let data = try await Self.readBody(bytes)
        return try JSONDecoder().decode(T.self, from: data)
    }
    func pair(code: String) async throws {
        let result: Pairing = try await request("/api/native/pair", body: ["code": code.trimmingCharacters(in: .whitespacesAndNewlines)], authenticated: false)
        try Credentials.save(result.validatedToken(), server: server)
    }
    func send(_ text: String, id: String) async throws -> Turn {
        let turn: Turn = try await request("/api/native/turns", body: ["id": id, "text": text])
        return try turn.validated(for: id)
    }
    func poll(_ id: String) async throws -> Turn {
        let turn: Turn = try await request("/api/native/turns/\(id)")
        return try turn.validated(for: id)
    }
}
