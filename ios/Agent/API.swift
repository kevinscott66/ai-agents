struct ConversationRecord: Codable, Identifiable { let id: String; let title: String; let updated: Double }
struct ConversationMessage: Codable, Identifiable { let seq: Int; let id: String; let role: String; let text: String }
struct ConversationIndex: Decodable { let conversations: [ConversationRecord]; let running: Bool; let nextCursor: String?; let more: Bool }
struct ConversationHistory: Decodable { let messages: [ConversationMessage]; let more: Bool; let running: Bool }
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
struct TurnRejected: LocalizedError {
    let message: String
    var errorDescription: String? { message }
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
    static func turnWasRejected(status: Int, data: Data) -> Bool {
        struct Failure: Decodable { let error: String }
        guard let failure = try? JSONDecoder().decode(Failure.self, from: data) else { return false }
        let failures: [Int: Set<String>] = [400: ["invalid_turn", "invalid_body", "body_aborted"], 401: ["unauthorized"], 403: ["native_only"], 404: ["not_found"], 408: ["body_timeout"], 413: ["body_too_large"], 415: ["json_required"], 409: ["busy", "conflict"], 503: ["lead_unavailable", "native_disabled"]]
        return failures[status]?.contains(failure.error) == true
    }
    private func urlRequest(_ path: String, body: [String: String]?, authenticated: Bool, expectedToken: String?) throws -> URLRequest {
        guard var parts = URLComponents(string: server), parts.scheme == "https", parts.host != nil,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else { throw AgentError.message("Укажите HTTPS-адрес сервера без пути") }
        guard let route = URLComponents(string: path), route.scheme == nil, route.host == nil, route.fragment == nil else { throw AgentError.message("Некорректный путь запроса") }
        parts.path = route.path; parts.percentEncodedQuery = route.percentEncodedQuery
        guard let url = parts.url else { throw AgentError.message("Некорректный адрес") }
        var request = URLRequest(url: url)
        request.timeoutInterval = 25
        if authenticated {
            guard let token = Credentials.read(server: server) else { throw AgentError.message("Подключите устройство в настройках") }
            if let expectedToken, token != expectedToken { throw AgentError.message("Подключение изменилось. Обновите подтверждения.") }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        return request
    }
    private static func session(resourceTimeout: TimeInterval = 30) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.timeoutIntervalForResource = resourceTimeout
        return URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }
    private func request<T: Decodable>(_ path: String, body: [String: String]? = nil, authenticated: Bool = true, expectedToken: String? = nil) async throws -> T {
        let request = try urlRequest(path, body: body, authenticated: authenticated, expectedToken: expectedToken)
        let session = Self.session()
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            let message = code == 401 ? "Код или ключ недействителен. Подключите устройство заново." : code == 409 ? "Лид уже выполняет запрос. Дождитесь результата." : code == 503 ? "Лид или доступ приложения пока недоступен." : "Сервер вернул ошибку \(code)"
            if path == "/api/native/turns", body != nil {
                let data = try await Self.readBody(bytes)
                if Self.turnWasRejected(status: code, data: data) { throw TurnRejected(message: message) }
            }
            throw AgentError.message(message)
        }
        guard response.expectedContentLength <= Int64(Self.maximumResponseBytes) else {
            throw AgentError.message("Ответ сервера слишком большой")
        }
        let data = try await Self.readBody(bytes)
        return try JSONDecoder().decode(T.self, from: data)
    }
    /// Максимум текста за один запрос озвучки: сервер отвергает `text.length > 4000` в единицах UTF-16.
    static let speechTextLimit = 4_000
    static let maximumSpeechBytes = 8 * 1_024 * 1_024
    /// Режет ответ на куски для `/voice/speech`, предпочитая границу пробела или конца фразы во второй половине куска.
    /// По умолчанию половина серверного лимита — как `speechChunks` в web-chat: первый кусок озвучивается быстрее.
    static func speechChunks(_ text: String, limit: Int = speechTextLimit / 2) -> [String] {
        var chunks: [String] = []
        var rest = Substring(text)
        while !rest.isEmpty {
            var end = rest.startIndex, units = 0
            while end < rest.endIndex, units + rest[end].utf16.count <= limit { units += rest[end].utf16.count; end = rest.index(after: end) }
            if end == rest.startIndex { end = rest.index(after: end) }
            if end < rest.endIndex {
                var cut = end, seen = 0
                while cut > rest.startIndex, seen * 2 < units {
                    let previous = rest.index(before: cut)
                    if rest[previous].isWhitespace || ".!?…".contains(rest[previous]) { end = cut; break }
                    seen += rest[previous].utf16.count; cut = previous
                }
            }
            chunks.append(String(rest[..<end])); rest = rest[end...]
        }
        return chunks
    }
    /// Тот же голос, что в голосовом разговоре: серверный TTS, а не системный синтезатор iOS.
    func speech(_ text: String, expectedToken: String? = nil) async throws -> Data {
        var request = try urlRequest("/api/native/voice/speech", body: ["text": text], authenticated: true, expectedToken: expectedToken)
        request.timeoutInterval = 50
        // Сервер ждёт провайдера до 45 с; клиент не должен сдаваться раньше.
        let session = Self.session(resourceTimeout: 60)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw AgentError.message(code == 401 ? "Код или ключ недействителен. Подключите устройство заново." : code == 429 ? "Озвучка занята. Повторите через минуту." : code == 503 ? "Озвучка на сервере не настроена." : "Не удалось озвучить ответ (\(code))")
        }
        guard http.mimeType == "audio/mpeg", response.expectedContentLength <= Int64(Self.maximumSpeechBytes) else { throw AgentError.message("Сервер вернул не аудио") }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < Self.maximumSpeechBytes else { throw AgentError.message("Аудио ответа слишком большое") }
            data.append(byte)
        }
        guard !data.isEmpty else { throw AgentError.message("Сервер вернул пустое аудио") }
        return data
    }
    func conversations(cursor: String? = nil, expectedToken: String? = nil) async throws -> ConversationIndex {
        var route = URLComponents(); route.path = "/api/native/conversations"
        if let cursor { route.queryItems = [URLQueryItem(name: "cursor", value: cursor)] }
        return try await request(route.string!, expectedToken: expectedToken)
    }
    static func conversationTitle(_ text: String) -> String {
        var result = ""
        for scalar in text.unicodeScalars {
            guard result.utf16.count + scalar.utf16.count <= 100 else { break }
            result.unicodeScalars.append(scalar)
        }
        return result
    }
    func createConversation(_ id: String, title: String, expectedToken: String? = nil) async throws {
        struct Result: Decodable { let conversation: ConversationRecord }
        let _: Result = try await request("/api/native/conversations", body: ["id":id,"title":Self.conversationTitle(title)], expectedToken: expectedToken)
    }
    func history(_ id: String, before: Int? = nil, expectedToken: String? = nil) async throws -> ConversationHistory {
        guard id.range(of: #"^[a-zA-Z0-9-]{16,64}$"#, options: .regularExpression) != nil else { throw AgentError.message("Некорректный диалог") }
        return try await request("/api/native/conversations/" + id + (before.map { "?before=\($0)" } ?? ""), expectedToken: expectedToken)
    }
    func ownerID(expectedToken: String? = nil) async throws -> String {
        struct Status: Decodable { let userId: String }
        let status: Status = try await request("/api/native/status", expectedToken: expectedToken)
        guard !status.userId.isEmpty, status.userId.allSatisfy({ $0.isNumber }), Int64(status.userId) != nil else { throw AgentError.message("Некорректный ответ сервера") }
        return status.userId
    }
    func pair(code: String) async throws {
        let result: Pairing = try await request("/api/native/pair", body: ["code": code.trimmingCharacters(in: .whitespacesAndNewlines)], authenticated: false)
        try Credentials.save(result.validatedToken(), server: server)
    }
    func send(_ text: String, id: String, conversationId: String? = nil, expectedToken: String? = nil) async throws -> Turn {
        var body = ["id": id, "text": text]
        if let conversationId { body["conversationId"] = conversationId }
        let turn: Turn = try await request("/api/native/turns", body: body, expectedToken: expectedToken)
        return try turn.validated(for: id)
    }
    func poll(_ id: String, expectedToken: String? = nil) async throws -> Turn {
        let turn: Turn = try await request("/api/native/turns/\(id)", expectedToken: expectedToken)
        return try turn.validated(for: id)
    }
}
