import Foundation
import Security
import Combine

struct DesktopState: Codable {
    var server = AppConfiguration.server
    var conversation = ""
    var pending = ""
    var messages: [ChatLine] = []
    var macros: [Macro] = []
}
enum Vault {
    static func query(_ server: String) -> [String: Any] { [kSecClass as String:kSecClassGenericPassword, kSecAttrService as String:"tech.dobropalm.agent.mac", kSecAttrAccount as String:server] }
    static func read(_ server: String) -> String {
        var q = query(server); q[kSecReturnData as String] = true
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
    static func save(_ token: String, server: String) throws {
        let q = query(server), data = Data(token.utf8)
        let status = SecItemUpdate(q as CFDictionary, [kSecValueData as String:data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = q; add[kSecValueData as String] = data; add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw DesktopError.message("Не удалось сохранить подключение в Связке ключей") }; return
        }
        guard status == errSecSuccess else { throw DesktopError.message("Не удалось обновить Связку ключей") }
    }
}
@MainActor final class DesktopModel: ObservableObject {
    @Published var data = DesktopState()
    @Published var error = ""
    @Published var busy = false
    @Published var connected = false
    private let file: URL
    private var storageReadable = true
    init(directory: URL? = nil) {
        let dir = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("DobropalmAgent")
        file = dir.appendingPathComponent("desktop.json")
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            if FileManager.default.fileExists(atPath: file.path) { data = try JSONDecoder().decode(DesktopState.self, from: Data(contentsOf: file)) }
        } catch { storageReadable = false; self.error = "Не удалось прочитать локальную историю. Данные не перезаписаны." }
        connected = !Vault.read(data.server).isEmpty
    }
    func saveMacro(_ macro: Macro) throws {
        try validate(macro)
        guard !data.macros.contains(where:{ $0.id != macro.id && !$0.phrase.isEmpty && $0.phrase.lowercased() == macro.phrase.lowercased() }) else { throw DesktopError.message("Эта фраза уже назначена другой команде") }
        let old = data.macros
        if let i = data.macros.firstIndex(where:{$0.id == macro.id}) { data.macros[i] = macro } else { data.macros.append(macro) }
        do { try persist() } catch { data.macros = old; throw error }
    }
    func deleteMacro(_ id: UUID) { let old = data.macros; data.macros.removeAll{$0.id == id}; do { try persist() } catch { data.macros = old; self.error = error.localizedDescription } }
    func createScenario(_ description: String) async {
        await send("Составь сценарий macOS по описанию: \(description). Только подготовь JSON, не выполняй действия и не вызывай инструменты. Формат: {\"name\":\"Название\",\"phrase\":\"фраза\",\"steps\":[{\"kind\":\"application\",\"value\":\"com.apple.Safari\"}]}. Разрешённые kind: application (bundle ID), website (http/https), volume (0..100), pause (секунды 0..30), speech (текст), shortcut (copy/paste/undo/save/space/return/escape/left/right/up/down, обязательный target=bundle ID). До20шагов. Не придумывай координаты. Ответ только JSON, пользователь проверит и запустит отдельно.")
    }
    func persist() throws {
        guard storageReadable else { throw DesktopError.message("Локальная история повреждена. Сначала восстановите desktop.json из резервной копии.") }
        try JSONEncoder().encode(data).write(to: file, options: [.atomic, .completeFileProtectionUnlessOpen])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
    func pair(server: String, code: String) async {
        guard !busy else { return }
        busy = true; error = ""; defer { busy = false }
        do {
            let url = try secureServer(server)
            guard data.pending.isEmpty || url.absoluteString == data.server else { throw DesktopError.message("Пока запрос не завершён, нельзя сменить сервер") }
            guard code.range(of: "^[a-fA-F0-9]{32}$", options: .regularExpression) != nil else { throw DesktopError.message("Введите одноразовый код из /pair_native в личном чате Лида") }
            struct Pair: Decodable { let token: String }
            let raw = try await AgentService(server: url, token: "").call("pair", body: ["code":code.lowercased()])
            let result = try JSONDecoder().decode(Pair.self, from: raw)
            guard result.token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw DesktopError.message("Сервер вернул некорректный ключ") }
            try Vault.save(result.token, server: url.absoluteString)
            if data.server != url.absoluteString { data.conversation = ""; data.messages = [] }
            data.server = url.absoluteString; connected = true; try persist()
        } catch { self.error = error.localizedDescription }
    }
    private func service() throws -> AgentService {
        let token = Vault.read(data.server)
        guard !token.isEmpty else { throw DesktopError.message("Сначала подключите Mac в настройках") }
        return AgentService(server: try secureServer(data.server), token: token)
    }
    func send(_ text: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !busy, data.pending.isEmpty, !text.isEmpty else { return }
        busy = true; error = ""; defer { busy = false }
        do {
            guard text.count <= 8000 else { throw DesktopError.message("Сообщение слишком длинное") }
            let api = try service()
            if data.conversation.isEmpty {
                let id = UUID().uuidString
                _ = try await api.call("conversations", body: ["id":id, "title":"Mac"])
                data.conversation = id; try persist()
            }
            data.pending = UUID().uuidString
            data.messages.append(ChatLine(role: "Вы", text: text))
            try persist()
            _ = try await api.call("turns", body: ["id":data.pending, "text":text, "conversationId":data.conversation])
            try await poll(api)
        } catch { self.error = error.localizedDescription }
    }
    func resume() async {
        guard !busy, !data.pending.isEmpty else { return }
        busy = true; error = ""; defer { busy = false }
        do { try await poll(service()) } catch { self.error = error.localizedDescription }
    }
    private func poll(_ api: AgentService) async throws {
        let id = data.pending
        for _ in 0..<120 {
            try Task.checkCancellation()
            let raw: Data
            do { raw = try await api.call("turns/" + id) }
            catch let failure as HTTPFailure where failure.status == 404 {
                data.pending = ""; try persist()
                throw DesktopError.message("Запрос не найден для этого подключения. Проверьте историю на iPhone перед повторной отправкой.")
            }
            let turn = try JSONDecoder().decode(RemoteTurn.self, from: raw)
            guard turn.id == id, ["running","done","error","interrupted"].contains(turn.status), turn.replies.count <= 80, turn.replies.allSatisfy({ $0.utf16.count <= 32000 }) else { throw DesktopError.message("Некорректный ответ сервера") }
            if turn.status != "running" {
                for reply in turn.replies { data.messages.append(ChatLine(role: "Лид", text: reply)) }
                data.pending = ""; try persist()
                if turn.status != "done" { error = "Выполнение остановлено: \(turn.status). Проверьте ответ перед повтором." }
                return
            }
            try await Task.sleep(for: .seconds(2))
        }
        error = "Агент продолжает работу. Нажмите «Проверить ответ» позже."
    }
}
