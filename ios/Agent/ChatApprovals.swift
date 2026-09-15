import SwiftUI

struct ChatApproval: Identifiable, Decodable {
    let id: String
    let chat_id: Int64
    let requested_by: String
    let action_type: String
    let status: String
    let payload: ApprovalValue?
    let redacted: Bool?
    let execution: String?
    var details: String { payload?.description ?? "Описание отсутствует" }
}
indirect enum ApprovalValue: Decodable {
    case text(String), object([String: ApprovalValue]), array([ApprovalValue]), other(String)
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .other("—") }
        else if let text = try? value.decode(String.self) { self = .text(text) }
        else if let dict = try? value.decode([String: ApprovalValue].self) { self = .object(dict) }
        else if let list = try? value.decode([ApprovalValue].self) { self = .array(list) }
        else if let flag = try? value.decode(Bool.self) { self = .other(flag ? "Да" : "Нет") }
        else { self = .other(String(try value.decode(Double.self))) }
    }
    subscript(key: String) -> String? {
        if case .object(let fields) = self, case .text(let text) = fields[key] { return text }; return nil
    }
    var description: String {
        switch self {
        case .text(let text), .other(let text): return text
        case .object(let fields): return fields.keys.sorted().map { "\($0): \(fields[$0]!.description)" }.joined(separator: "\n")
        case .array(let values): return values.map(\.description).joined(separator: "\n")
        }
    }
}
@MainActor final class ChatApprovals: ObservableObject {
    @Published var items: [ChatApproval] = []
    @Published var outcomes: [String: String] = [:]
    @Published var working: Set<String> = []
    @Published var error: String?
    private var currentServer = ""
    private var currentConversation: String?
    private var currentOwner = ""
    private var credential: String?
    private var generation = UUID()
    private var terminal: Set<String> = []
    private var awaitingDecision: Set<String> = []
    private func matches(_ server: String, _ token: String) -> Bool { currentServer == server && credential == token && Credentials.read(server: server) == token }
    func refresh(server: String, conversation: String? = nil) async {
        let token = Credentials.read(server: server)
        if currentServer != server || credential != token || currentConversation != conversation {
            currentServer = server; credential = token; currentConversation = conversation
            currentOwner = ""; items = []; outcomes = [:]; working = []; awaitingDecision = []; terminal = []; error = nil
            generation = UUID()
        }
        guard let token, let conversation else { return }
        let operation = generation
        do {
            let owner = try await AgentAPI(server: server).ownerID(expectedToken: token)
            guard matches(server, token), generation == operation else { return }
            currentOwner = owner
            let data = try await PanelTransport.request(server: server, path: "/api/native/conversations/\(conversation)/approvals", method: "GET", body: nil, expectedToken: token)
            guard matches(server, token), generation == operation else { return }
            guard data["status"] as? Int == 200, let text = data["body"] as? String else { throw AgentError.message("Не удалось проверить подтверждения") }
            struct List: Decodable { let approvals: [ChatApproval] }
            items = try JSONDecoder().decode(List.self, from: Data(text.utf8)).approvals.filter { String($0.chat_id) == owner }
            for item in items where !terminal.contains(item.id) {
                if item.execution == "completed" {
                    outcomes[item.id] = "Выполнено. Результат — в сообщении ниже."
                    terminal.insert(item.id); awaitingDecision.remove(item.id)
                } else if item.execution == "failed" || item.status == "failed" {
                    outcomes[item.id] = "Выполнение завершилось ошибкой."
                    terminal.insert(item.id); awaitingDecision.remove(item.id)
                } else if item.status == "rejected" || item.status == "expired" {
                    outcomes[item.id] = item.status == "rejected" ? "Отклонено. Действие не выполнено." : "Срок подтверждения истёк."
                    terminal.insert(item.id); awaitingDecision.remove(item.id)
                } else if item.status == "approved" {
                    outcomes[item.id] = "Подтверждение принято. Ожидаем результат выполнения…"
                    awaitingDecision.insert(item.id)
                }
            }
            error = nil
        } catch { if matches(server, token), generation == operation { self.error = "Не удалось обновить подтверждения. \(error.localizedDescription)" } }
    }
    func decide(_ item: ChatApproval, approve: Bool, server: String) async {
        guard let token = credential, matches(server, token) else {
            items = []; error = "Подключение изменилось. Обновляем подтверждения."; return
        }
        guard currentServer == server, String(item.chat_id) == currentOwner, error == nil, outcomes[item.id] == nil, !working.contains(item.id), item.redacted != true else { return }
        let operation = generation
        working.insert(item.id)
        defer { if matches(server, token), generation == operation { working.remove(item.id) } }
        // Freeze the card before POST. An uncertain transport result never retries itself.
        outcomes[item.id] = "Отправляем решение…"
        awaitingDecision.insert(item.id)
        do {
            let body = "{\"decision\":\"\(approve ? "approved" : "rejected")\"}"
            let response = try await PanelTransport.request(server: server, path: "/api/approvals/\(item.id)/decide", method: "POST", body: body, expectedToken: token)
            guard matches(server, token), generation == operation, !terminal.contains(item.id) else { return }
            let status = response["status"] as? Int ?? 0
            struct Decision: Decodable { let approval: ChatApproval; let executed: Bool; let result: ApprovalValue? }
            if status == 200, let text = response["body"] as? String,
               let result = try? JSONDecoder().decode(Decision.self, from: Data(text.utf8)),
               result.approval.id == item.id, result.approval.chat_id == item.chat_id,
               result.approval.status == (approve ? "approved" : "rejected"), result.executed == approve {
                awaitingDecision.remove(item.id)
                terminal.insert(item.id)
                outcomes[item.id] = approve ? "Выполнено. Результат — в сообщении ниже." : "Отклонено. Действие не выполнено."
            } else {
                outcomes[item.id] = "Сервер не подтвердил выполнение (\(status)). Проверьте результат у Агента перед повтором."
            }
        } catch {
            guard matches(server, token), generation == operation, !terminal.contains(item.id) else { return }
            outcomes[item.id] = "Результат неизвестен. Решение могло быть принято. Уточните состояние у Агента; повтор автоматически не отправляется."
        }
    }
}
struct ChatApprovalCard: View {
    let item: ChatApproval
    let outcome: String?
    let working: Bool
    let decide: (Bool) -> Void
    @State private var expanded = true
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(outcome == nil ? "Нужно подтверждение" : "Подтверждение действия", systemImage: "hand.raised").font(.headline)
            Text(item.action_type == "MAC_RUN_CLAUDE" ? "Сессия \(item.payload?["provider"] == "codex" ? "Codex" : "Claude Code") на Mac" : item.action_type.replacingOccurrences(of: "_", with: " ")).font(.subheadline.weight(.semibold))
            Text("Запрос от \(item.requested_by)").font(.caption).foregroundStyle(.secondary)
            DisclosureGroup("Параметры действия", isExpanded: $expanded) {
                ScrollView { Text(item.details).font(.system(.footnote, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 260)
            }
            if let outcome { Text(outcome).font(.subheadline).foregroundStyle(.secondary) }
            else if item.redacted == true { Text("Недостаточно прав для просмотра и подтверждения.").font(.footnote) }
            else {
                HStack(spacing: 12) {
                    Button("Отклонить", role: .destructive) { decide(false) }.buttonStyle(.bordered)
                    Button { decide(true) } label: { Text("Подтвердить").foregroundStyle(scheme == .dark ? Color.black : Color.white) }.buttonStyle(.borderedProminent).tint(scheme == .dark ? Color.white : Color.black)
                }.controlSize(.large).disabled(working)
            }
            if working { ProgressView("Применяем решение…").font(.caption) }
        }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 22))
    }
}

#if DEBUG
struct ChatApprovalPreview: View {
    @State private var outcome: String? = ProcessInfo.processInfo.arguments.contains("--approval-result-preview") ? "Выполнено. Результат — в сообщении ниже." : nil
    private let item = try! JSONDecoder().decode(ChatApproval.self, from: Data(#"{"id":"preview-only","chat_id":1,"requested_by":"Агент","action_type":"Обновить задачу","status":"pending","payload":{"Задача":"Подготовить утреннюю сводку","Изменение":"Перенести на завтра, 09:00"}}"#.utf8))
    var body: some View {
        NavigationStack {
            ScrollView { VStack(alignment: .leading, spacing: 24) {
                Text("Подготовил изменение. Подтвердите его перед выполнением.")
                ChatApprovalCard(item: item, outcome: outcome, working: false) { outcome = $0 ? "Пример: подтверждено" : "Пример: отклонено" }
                if ProcessInfo.processInfo.arguments.contains("--approval-result-preview") { Text("Тест").font(.body).textSelection(.enabled).padding(.top, 4) }
            }.padding(22) }.navigationTitle("Агент")
        }.tint(.primary)
    }
}
#endif
