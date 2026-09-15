import SwiftUI

struct ChatApproval: Identifiable, Decodable {
    let id: String
    let chat_id: Int64
    let requested_by: String
    let action_type: String
    let status: String
    let payload: ApprovalValue?
    let redacted: Bool?
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
    private var refreshing = false
    private var awaitingDecision: Set<String> = []
    private var currentOwner = ""
    private var credential: String?
    private func matches(_ server: String, _ token: String) -> Bool { currentServer == server && credential == token && Credentials.read(server: server) == token }
    func refresh(server: String) async {
        let token = Credentials.read(server: server)
        if currentServer != server || credential != token {
            currentServer = server; credential = token; currentOwner = ""; items = []; outcomes = [:]; working = []; awaitingDecision = []
        }
        guard !refreshing, let token else { return }
        refreshing = true; defer { refreshing = false }
        do {
            let owner = try await AgentAPI(server: server).ownerID(expectedToken: token)
            guard matches(server, token) else { return }
            if currentOwner != owner { currentOwner = owner; items = []; outcomes = [:]; working = []; awaitingDecision = [] }
            let data = try await PanelTransport.request(server: server, path: "/api/approvals?status=pending&chat_id=\(owner)&limit=200", method: "GET", body: nil, expectedToken: token)
            guard matches(server, token) else { return }
            guard data["status"] as? Int == 200, let text = data["body"] as? String else { throw AgentError.message("Не удалось проверить подтверждения") }
            struct List: Decodable { let approvals: [ChatApproval] }
            let incoming = try JSONDecoder().decode(List.self, from: Data(text.utf8)).approvals.filter { String($0.chat_id) == owner }
            let ids = Set(incoming.map(\.id))
            for old in items where !ids.contains(old.id) && outcomes[old.id] == nil && !working.contains(old.id) {
                outcomes[old.id] = "Больше не ожидает подтверждения. Решение могло быть принято в другом окне."
            }
            let oldIDs = Set(items.map(\.id))
            items += incoming.filter { !oldIDs.contains($0.id) }
            if !awaitingDecision.isEmpty {
                for status in ["approved", "failed", "rejected"] {
                    let response = try await PanelTransport.request(server: server, path: "/api/approvals?status=\(status)&chat_id=\(owner)&limit=200", method: "GET", body: nil, expectedToken: token)
                    guard matches(server, token) else { return }
                    guard response["status"] as? Int == 200, let body = response["body"] as? String else { throw AgentError.message("Не удалось проверить решение") }
                    let resolved = try JSONDecoder().decode(List.self, from: Data(body.utf8)).approvals
                    for item in resolved where awaitingDecision.contains(item.id) && String(item.chat_id) == owner && item.status == status {
                        if status == "approved" {
                            // Decision is durable before execution finishes. Never infer completion.
                            outcomes[item.id] = "Подтверждение принято сервером. Действие выполняется или уже завершено. Результат можно проверить у Агента."
                        } else {
                            outcomes[item.id] = status == "failed" ? "Подтверждение принято, но выполнение завершилось ошибкой. Уточните результат у Агента." : "Отклонено. Действие не выполнено."
                            awaitingDecision.remove(item.id)
                        }
                    }
                }
            }
            if !awaitingDecision.isEmpty {
                let response = try await PanelTransport.request(server: server, path: "/api/actions?type=MAC_RUN_CLAUDE&status=ok&chat_id=\(owner)&limit=200", method: "GET", body: nil, expectedToken: token)
                guard matches(server, token) else { return }
                if response["status"] as? Int == 200, let body = response["body"] as? String {
                    struct Action: Decodable { let chat_id: Int64; let status: String; let result: ApprovalValue? }
                    struct Actions: Decodable { let actions: [Action] }
                    for action in try JSONDecoder().decode(Actions.self, from: Data(body.utf8)).actions {
                        guard String(action.chat_id) == owner, action.status == "ok", let id = action.result?["approvalId"], awaitingDecision.contains(id) else { continue }
                        outcomes[id] = "Выполнено.\n" + (action.result?["output"] ?? "Команда завершилась успешно.")
                        awaitingDecision.remove(id)
                    }
                }
            }
            error = nil
        } catch { if matches(server, token) { self.error = "Не удалось обновить подтверждения. \(error.localizedDescription)" } }
    }
    func decide(_ item: ChatApproval, approve: Bool, server: String) async {
        guard let token = credential, matches(server, token) else {
            items = []; error = "Подключение изменилось. Обновляем подтверждения."; return
        }
        guard currentServer == server, String(item.chat_id) == currentOwner, error == nil, outcomes[item.id] == nil, !working.contains(item.id), item.redacted != true else { return }
        working.insert(item.id)
        defer { if matches(server, token) { working.remove(item.id) } }
        // Freeze the card before POST. An uncertain transport result never retries itself.
        outcomes[item.id] = "Отправляем решение…"
        awaitingDecision.insert(item.id)
        do {
            let body = "{\"decision\":\"\(approve ? "approved" : "rejected")\"}"
            let response = try await PanelTransport.request(server: server, path: "/api/approvals/\(item.id)/decide", method: "POST", body: body, expectedToken: token)
            guard matches(server, token) else { return }
            let status = response["status"] as? Int ?? 0
            struct Decision: Decodable { let approval: ChatApproval; let executed: Bool; let result: ApprovalValue? }
            if status == 200, let text = response["body"] as? String,
               let result = try? JSONDecoder().decode(Decision.self, from: Data(text.utf8)),
               result.approval.id == item.id, result.approval.chat_id == item.chat_id,
               result.approval.status == (approve ? "approved" : "rejected"), result.executed == approve {
                awaitingDecision.remove(item.id)
                outcomes[item.id] = approve ? "Подтверждено. Сервер завершил выполнение действия." + (result.result?["output"].map { "\n" + $0 } ?? "") : "Отклонено. Действие не выполнено."
            } else {
                outcomes[item.id] = "Сервер не подтвердил выполнение (\(status)). Проверьте результат у Агента перед повтором."
            }
        } catch {
            guard matches(server, token) else { return }
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
            Label("Нужно подтверждение", systemImage: "hand.raised").font(.headline)
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
    @State private var outcome: String?
    private let item = try! JSONDecoder().decode(ChatApproval.self, from: Data(#"{"id":"preview-only","chat_id":1,"requested_by":"Агент","action_type":"Обновить задачу","status":"pending","payload":{"Задача":"Подготовить утреннюю сводку","Изменение":"Перенести на завтра, 09:00"}}"#.utf8))
    var body: some View {
        NavigationStack {
            ScrollView { VStack(alignment: .leading, spacing: 24) {
                Text("Подготовил изменение. Подтвердите его перед выполнением.")
                ChatApprovalCard(item: item, outcome: outcome, working: false) { outcome = $0 ? "Пример: подтверждено" : "Пример: отклонено" }
            }.padding(22) }.navigationTitle("Агент")
        }.tint(.primary)
    }
}
#endif
