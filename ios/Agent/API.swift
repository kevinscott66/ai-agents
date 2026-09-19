struct KnowledgeProject: Codable, Identifiable { let id: String; let title: String; var updated: Double? = nil }
struct KnowledgeEntry: Codable, Identifiable {
    let id: String
    let kind: String
    let text: String
    let sourceMessageIds: [String]
    var sourceConversationId: String? = nil
    var projectIdentity: String { (sourceConversationId ?? "") + ":" + id }
    var kindLabel: String { ["fact":"Факт", "decision":"Решение", "task":"Задача"][kind] ?? "Запись" }
}
struct KnowledgeProposal: Codable, Identifiable {
    let id: String
    let projectId: String
    let conversationId: String
    let revision: Int
    let entry: KnowledgeEntry
}
struct KnowledgeMemoryState: Decodable { let state: String; let updated: Double }
struct KnowledgeSnapshot: Decodable {
    let revision: Int
    let entries: [KnowledgeEntry]
    let project: KnowledgeProject?
    let projectEntries: [KnowledgeEntry]
    let proposals: [KnowledgeProposal]
    var memoryState: KnowledgeMemoryState? = nil
}
struct ConversationRecord: Codable, Identifiable { let id: String; let title: String; let updated: Double; var archived: Int? = nil }
struct SharedLocation: Codable, Equatable {
    let latitude: Double
    let longitude: Double
    var accuracy: Double? = nil
}
struct NativeAttachment: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let mimeType: String
    let size: Int
}
struct AttachmentPreview: Codable { let mimeType: String; let data: String }
struct AttachmentDraft: Identifiable {
    let id: String
    let name: String
    let mimeType: String
    let data: Data
    var text: String? = nil
    var previews: [AttachmentPreview] = []
    var metadata: NativeAttachment { NativeAttachment(id: id, name: name, mimeType: mimeType, size: data.count) }
}
struct NativeReplyDetail: Codable { let messageId: String; let agentKey: String }
enum AgentRole {
    static func name(_ key: String?) -> String {
        let names = ["orchestrator":"Лид", "pm":"Менеджер проекта", "product":"Продукт", "backend":"Backend", "frontend":"Frontend", "tgdev":"Telegram", "aieng":"AI-инженер", "qa":"Тестирование", "smm":"SMM", "copy":"Редактор", "design":"Дизайн", "perm":"Разрешения"]
        return key.flatMap { names[$0] } ?? "Агент"
    }
}
struct ConversationMessage: Codable, Identifiable {
    let seq: Int; let id: String; let role: String; let text: String
    /// Миллисекунды Unix; у сообщений до появления времени на сервере его нет.
    var created: Double? = nil
    var agentKey: String? = nil
    var attachments: [NativeAttachment]? = nil
    var location: SharedLocation? = nil
}
struct NativeGeneration: Codable, Identifiable, Equatable {
    let id: String
    let state: String
    let started: Double
    var ended: Double? = nil
}
struct NativeOutputMedia: Codable {
    let messageId: String
    let attachments: [NativeAttachment]
}
struct ConversationIndex: Decodable { let conversations: [ConversationRecord]; let running: Bool; let nextCursor: String?; let more: Bool }
struct ConversationHistory: Decodable { let messages: [ConversationMessage]; let more: Bool; let running: Bool; var generations: [NativeGeneration]? = nil }
import Foundation
import Security

struct Turn: Codable {
    let id: String
    let status: String
    let replies: [String]
    var replyDetails: [NativeReplyDetail]? = nil
    var outputMedia: [NativeOutputMedia]? = nil
    var generations: [NativeGeneration]? = nil
    func validated(for requestedID: String) throws -> Turn {
        guard id == requestedID, ["running", "done", "error", "interrupted"].contains(status),
              replies.count <= 80, replies.allSatisfy({ $0.utf16.count <= 8_000 }) else {
            throw AgentError.message("Некорректный ответ сервера. Ожидание запроса сохранено.")
        }
        if let details = replyDetails {
            let ids = Set(replies.indices.map { id + ":reply:" + String($0 + 1) })
            guard details.count <= replies.count, Set(details.map(\.messageId)).count == details.count, details.allSatisfy({ ids.contains($0.messageId) && $0.agentKey.utf16.count <= 64 }) else { throw AgentError.message("Некорректные роли в ответе сервера") }
        }
        let outputs = outputMedia ?? []
        let jobs = generations ?? []
        let replyIDs = Set(replies.indices.map { id + ":reply:" + String($0 + 1) })
        guard outputs.count <= 80, Set(outputs.map(\.messageId)).count == outputs.count,
              outputs.allSatisfy({ output in replyIDs.contains(output.messageId) && output.attachments.count <= 4 && output.attachments.allSatisfy { item in
                  item.id.range(of: #"^[a-zA-Z0-9-]{16,64}$"#, options: .regularExpression) != nil && item.size > 0 && item.size <= 10 * 1024 * 1024 && item.name.utf16.count <= 255 && item.mimeType.count <= 127
              } }), jobs.count <= 80, Set(jobs.map(\.id)).count == jobs.count,
              jobs.allSatisfy({ UUID(uuidString: $0.id) != nil && ["running", "completed", "failed", "interrupted"].contains($0.state) && $0.started.isFinite && ($0.ended?.isFinite ?? true) }) else {
            throw AgentError.message("Некорректные медиа в ответе сервера")
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
    /// Servers this iPhone already holds a device key for; OpenFlux settings share the service but not the https:// account.
    static func pairedServers() -> [String] {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "tech.dobropalm.agent",
            kSecMatchLimit as String: kSecMatchLimitAll, kSecReturnAttributes as String: true]
        var items: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &items) == errSecSuccess, let list = items as? [[String: Any]] else { return [] }
        return list.compactMap { $0[kSecAttrAccount as String] as? String }.filter { $0.hasPrefix("https://") }.sorted()
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
        let failures: [Int: Set<String>] = [400: ["invalid_turn", "invalid_body", "body_aborted", "invalid_media"], 401: ["unauthorized"], 403: ["native_only"], 404: ["not_found"], 408: ["body_timeout"], 413: ["body_too_large"], 415: ["json_required"], 409: ["busy", "conflict", "media_conflict"], 503: ["lead_unavailable", "native_disabled"]]
        return failures[status]?.contains(failure.error) == true
    }
    static func validateCredential(_ current: String?, expected: String?) throws {
        if let expected, current != expected { throw AgentError.message("Подключение изменилось. Откройте экран заново.") }
    }
    private func request<T: Decodable>(_ path: String, body: [String: String]? = nil, authenticated: Bool = true, expectedToken: String? = nil, encodedBody: Data? = nil) async throws -> T {
        guard var parts = URLComponents(string: server), parts.scheme == "https", parts.host != nil,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else { throw AgentError.message("Укажите HTTPS-адрес сервера без пути") }
        guard let route = URLComponents(string: path), route.scheme == nil, route.host == nil, route.fragment == nil else { throw AgentError.message("Некорректный путь запроса") }
        parts.path = route.path; parts.percentEncodedQuery = route.percentEncodedQuery
        guard let url = parts.url else { throw AgentError.message("Некорректный адрес") }
        var request = URLRequest(url: url)
        request.timeoutInterval = (path == "/api/native/attachments" || path.hasPrefix("/api/native/voice/")) ? 120 : 25
        if authenticated {
            guard let token = Credentials.read(server: server) else { throw AgentError.message("Подключите устройство в настройках") }
            if let expectedToken, token != expectedToken { throw AgentError.message("Подключение изменилось. Обновите подтверждения.") }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if body != nil || encodedBody != nil {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try encodedBody ?? JSONEncoder().encode(body!)
        }
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.timeoutIntervalForResource = (path == "/api/native/attachments" || path.hasPrefix("/api/native/voice/")) ? 180 : 30
        #if os(iOS)
        try await FluxNetwork.configure(config)
        if !config.proxyConfigurations.isEmpty { request.timeoutInterval = (path == "/api/native/attachments" || path.hasPrefix("/api/native/voice/")) ? 120 : config.timeoutIntervalForRequest }
        if path == "/api/native/attachments" || path.hasPrefix("/api/native/voice/") { config.timeoutIntervalForResource = 180 }
        #endif
        let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        // Proxy startup suspends; recheck immediately before any authenticated mutation leaves the device.
        try Self.validateCredential(Credentials.read(server: server), expected: expectedToken)
        let (bytes, response) = try await session.bytes(for: request)
        try Self.validateCredential(Credentials.read(server: server), expected: expectedToken)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            let errorData = path == "/api/native/attachments" ? try await Self.readBody(bytes) : nil
            let uploadError = errorData.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }?["error"]
            let isKnowledge = path.contains("/knowledge") || path == "/api/native/projects" || path.hasSuffix("/project") || path.hasSuffix("/proposals")
            let isVoice = path.hasPrefix("/api/native/voice/")
            let message = isVoice && code == 503 ? "Голосовой сервис не настроен или временно недоступен." : isVoice && code == 502 ? "Голосовой сервис не смог обработать запрос. Попробуйте снова." : isVoice && code == 429 ? "Голосовой сервис занят. Попробуйте немного позже." : isKnowledge && code == 409 ? "Предложение устарело. Обновите память диалога." : isKnowledge && code == 429 ? "Достигнут лимит памяти или проектов." : uploadError == "media_quota" ? "Хранилище вложений заполнено (лимит 40 МБ); файлы хранятся 30 дней." : code == 401 ? "Код или ключ недействителен. Подключите устройство заново." : code == 409 ? "Лид уже выполняет запрос. Дождитесь результата." : code == 503 ? "Лид или доступ приложения пока недоступен." : code == 413 ? "Файл слишком большой" : code == 507 ? "Хранилище вложений заполнено" : code == 429 ? "Загрузка уже идёт. Дождитесь завершения." : "Сервер вернул ошибку \(code)"
            if path == "/api/native/turns", (body != nil || encodedBody != nil) {
                let data = try await Self.readBody(bytes)
                if Self.turnWasRejected(status: code, data: data) { throw TurnRejected(message: message) }
            }
            throw AgentError.message(message)
        }
        guard response.expectedContentLength <= Int64(Self.maximumResponseBytes) else {
            throw AgentError.message("Ответ сервера слишком большой")
        }
        let data = try await Self.readBody(bytes)
        try Self.validateCredential(Credentials.read(server: server), expected: expectedToken)
        if T.self == Data.self, let audio = data as? T {
            guard http.mimeType == "audio/mpeg", !data.isEmpty else { throw AgentError.message("Голосовой сервис вернул некорректное аудио") }
            return audio
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func voiceAvailable(expectedToken: String) async throws -> Bool {
        struct Status: Decodable { let available: Bool }
        let status: Status = try await request("/api/native/voice/status", expectedToken: expectedToken)
        return status.available
    }
    func transcribeVoice(_ data: Data, expectedToken: String) async throws -> String {
        guard data.count <= 8 * 1024 * 1024 else { throw AgentError.message("Запись слишком длинная. Скажите короче.") }
        struct Transcript: Decodable { let text: String }
        let result: Transcript = try await request("/api/native/voice/transcribe", body: ["base64audio": data.base64EncodedString(), "mime": "audio/mp4"], expectedToken: expectedToken)
        return result.text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    func speechAudio(_ text: String, expectedToken: String) async throws -> Data {
        try await request("/api/native/voice/speech", body: ["text": text], expectedToken: expectedToken)
    }
    static func knowledgeRoute(_ conversationID: String, resource: String = "knowledge") throws -> String {
        guard conversationID.range(of: #"^[a-zA-Z0-9-]{16,64}$"#, options: .regularExpression) != nil else { throw AgentError.message("Некорректный диалог") }
        guard ["knowledge", "project", "proposals"].contains(resource) else { throw AgentError.message("Некорректный путь памяти") }
        return "/api/native/conversations/" + conversationID + "/" + resource
    }
    func knowledgeProjects(expectedToken: String) async throws -> [KnowledgeProject] {
        struct Result: Decodable { let projects: [KnowledgeProject] }
        let result: Result = try await request("/api/native/projects", expectedToken: expectedToken)
        return result.projects
    }
    func createKnowledgeProject(title: String, expectedToken: String) async throws -> KnowledgeProject {
        struct Result: Decodable { let project: KnowledgeProject }
        let result: Result = try await request("/api/native/projects", body: ["title":title], expectedToken: expectedToken)
        return result.project
    }
    func knowledge(_ conversationID: String, expectedToken: String) async throws -> KnowledgeSnapshot {
        try await request(Self.knowledgeRoute(conversationID), expectedToken: expectedToken)
    }
    func assignKnowledgeProject(_ projectID: String?, conversationID: String, expectedToken: String) async throws -> KnowledgeSnapshot {
        // JSONEncoder omits optional nil; the API requires an explicit null to detach.
        let data = try JSONSerialization.data(withJSONObject: ["projectId": projectID as Any? ?? NSNull()])
        return try await request(Self.knowledgeRoute(conversationID, resource: "project"), expectedToken: expectedToken, encodedBody: data)
    }
    func proposeKnowledge(_ entryID: String, conversationID: String, expectedToken: String) async throws {
        struct Result: Decodable { let proposal: KnowledgeProposal }
        let _: Result = try await request(Self.knowledgeRoute(conversationID, resource: "proposals"), body: ["entryId":entryID], expectedToken: expectedToken)
    }
    func decideKnowledge(_ proposalID: String, accept: Bool, expectedToken: String) async throws {
        guard proposalID.range(of: #"^[a-zA-Z0-9-]{16,64}$"#, options: .regularExpression) != nil else { throw AgentError.message("Некорректное предложение") }
        struct Decision: Encodable { let accept: Bool }
        struct Result: Decodable { let ok: Bool }
        let result: Result = try await request("/api/native/knowledge/proposals/" + proposalID, expectedToken: expectedToken, encodedBody: JSONEncoder().encode(Decision(accept: accept)))
        guard result.ok else { throw AgentError.message("Сервер не подтвердил решение. Обновите память.") }
    }
    func checkConnection() async throws {
        struct Health: Decodable {}
        let _: Health = try await request("/api/health", authenticated: false)
    }
    func conversations(cursor: String? = nil, archived: Bool = false, expectedToken: String? = nil) async throws -> ConversationIndex {
        var route = URLComponents(); route.path = "/api/native/conversations"
        var query: [URLQueryItem] = []
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        if archived { query.append(URLQueryItem(name: "archived", value: "1")) }
        if !query.isEmpty { route.queryItems = query }
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
    /// Переименовать и/или убрать в архив; nil — не менять.
    func editConversation(_ id: String, title: String? = nil, archived: Bool? = nil, expectedToken: String? = nil) async throws {
        guard id.range(of: #"^[a-zA-Z0-9-]{16,64}$"#, options: .regularExpression) != nil else { throw AgentError.message("Некорректный диалог") }
        struct Edit: Encodable { let title: String?; let archived: Bool? }
        struct Result: Decodable { let conversation: ConversationRecord }
        let _: Result = try await request("/api/native/conversations/" + id, expectedToken: expectedToken, encodedBody: JSONEncoder().encode(Edit(title: title.map(Self.conversationTitle), archived: archived)))
    }
    func deleteConversation(_ id: String, expectedToken: String? = nil) async throws {
        guard id.range(of: #"^[a-zA-Z0-9-]{16,64}$"#, options: .regularExpression) != nil else { throw AgentError.message("Некорректный диалог") }
        struct Result: Decodable { let ok: Bool }
        let _: Result = try await request("/api/native/conversations/" + id + "/delete", expectedToken: expectedToken, encodedBody: Data("{}".utf8))
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
    func send(_ text: String, id: String, conversationId: String? = nil, expectedToken: String? = nil,
              attachmentIds: [String] = [], location: SharedLocation? = nil) async throws -> Turn {
        struct Payload: Encodable { let id: String; let text: String; let conversationId: String?; let attachmentIds: [String]; let location: SharedLocation? }
        let data = try JSONEncoder().encode(Payload(id: id, text: text, conversationId: conversationId, attachmentIds: attachmentIds, location: location))
        let turn: Turn = try await request("/api/native/turns", expectedToken: expectedToken, encodedBody: data)
        return try turn.validated(for: id)
    }
    func upload(_ attachment: AttachmentDraft, expectedToken: String) async throws -> NativeAttachment {
        struct Upload: Encodable { let id: String; let name: String; let mimeType: String; let data: String; let text: String?; let previews: [AttachmentPreview] }
        struct Result: Decodable { let attachment: NativeAttachment }
        guard attachment.data.count <= 10 * 1024 * 1024 else { throw AgentError.message("Файл больше 10 МБ") }
        let payload = Upload(id: attachment.id, name: attachment.name, mimeType: attachment.mimeType,
                             data: attachment.data.base64EncodedString(), text: attachment.text, previews: attachment.previews)
        let data = try JSONEncoder().encode(payload)
        let result: Result = try await request("/api/native/attachments", expectedToken: expectedToken, encodedBody: data)
        guard result.attachment.id == attachment.id else { throw AgentError.message("Сервер вернул другой файл") }
        return result.attachment
    }
    func download(_ attachment: NativeAttachment, expectedToken: String) async throws -> Data {
        guard attachment.id.range(of: #"^[a-zA-Z0-9-]{16,64}$"#, options: .regularExpression) != nil else { throw AgentError.message("Некорректное вложение") }
        let url = try PanelTransportURL.attachment(server: server, id: attachment.id)
        guard Credentials.read(server: server) == expectedToken else { throw AgentError.message("Подключение изменилось") }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(expectedToken)", forHTTPHeaderField: "Authorization")
        let config = URLSessionConfiguration.ephemeral; config.httpShouldSetCookies = false
        config.timeoutIntervalForResource = 120
        #if os(iOS)
        try await FluxNetwork.configure(config)
        #endif
        let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else { throw AgentError.message("Файл недоступен или срок хранения истёк") }
        guard response.expectedContentLength <= 10 * 1024 * 1024 else { throw AgentError.message("Файл слишком большой") }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < 10 * 1024 * 1024 else { throw AgentError.message("Файл слишком большой") }
            data.append(byte)
        }
        guard Credentials.read(server: server) == expectedToken else { throw AgentError.message("Подключение изменилось") }
        return data
    }
    func poll(_ id: String, expectedToken: String? = nil) async throws -> Turn {
        let turn: Turn = try await request("/api/native/turns/\(id)", expectedToken: expectedToken)
        return try turn.validated(for: id)
    }
}

private enum PanelTransportURL {
    static func attachment(server: String, id: String) throws -> URL {
        guard var parts = URLComponents(string: server), parts.scheme == "https", parts.host != nil,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else { throw AgentError.message("Некорректный адрес сервера") }
        parts.path = "/api/native/attachments/" + id
        guard let url = parts.url else { throw AgentError.message("Некорректный адрес сервера") }
        return url
    }
}
