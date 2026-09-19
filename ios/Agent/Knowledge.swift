import SwiftUI

@MainActor final class KnowledgeModel: ObservableObject {
    @Published var snapshot: KnowledgeSnapshot?
    @Published var projects: [KnowledgeProject] = []
    @Published var loading = false
    @Published var working = false
    @Published var error: String?
    @Published var needsRefresh = false
    let server: String
    let conversationID: String
    private let token: String?
    private var preview = false
    #if DEBUG
    init(preview snapshot: KnowledgeSnapshot, projects: [KnowledgeProject]) {
        server = ""; conversationID = "preview"; token = nil; preview = true
        self.snapshot = snapshot; self.projects = projects
    }
    #endif
    private var currentIdentity: Bool { token != nil && Credentials.read(server: server) == token }
    init(server: String, conversationID: String) {
        self.server = server; self.conversationID = conversationID
        token = Credentials.read(server: server)
    }
    private func checkIdentity() throws -> String {
        guard currentIdentity, let token else {
            snapshot = nil; projects = []
            throw AgentError.message("Подключение изменилось. Откройте память диалога заново.")
        }
        return token
    }
    func refresh() async {
        guard !loading, !working, !preview else { return }
        loading = true; defer { loading = false }
        do {
            let token = try checkIdentity()
            let value = try await AgentAPI(server: server).knowledge(conversationID, expectedToken: token)
            let list = try await AgentAPI(server: server).knowledgeProjects(expectedToken: token)
            _ = try checkIdentity(); try Task.checkCancellation()
            snapshot = value; projects = list; error = nil; needsRefresh = false
        } catch is CancellationError { } catch { self.error = error.localizedDescription }
    }
    private func mutate(_ operation: (AgentAPI, String) async throws -> Void) async {
        guard !working, !loading, !needsRefresh else { return }
        working = true; error = nil
        do {
            let token = try checkIdentity()
            try await operation(AgentAPI(server: server), token)
            _ = try checkIdentity()
        } catch {
            // A lost response may mean the write succeeded. Reconcile by GET only.
            self.error = error.localizedDescription + " Обновите память, чтобы проверить результат."
            needsRefresh = true; working = false; return
        }
        needsRefresh = true
        working = false
        await refresh()
    }
    func assign(_ projectID: String?) async {
        await mutate { api, token in _ = try await api.assignKnowledgeProject(projectID, conversationID: self.conversationID, expectedToken: token) }
    }
    func createProject(_ title: String) async {
        await mutate { api, token in _ = try await api.createKnowledgeProject(title: title, expectedToken: token) }
    }
    func save(_ entryID: String, scope: String, kind: String, text: String, source: String? = nil) async {
        await mutate { api, token in _ = try await api.editKnowledge(entryID, scope: scope, kind: kind, text: text, sourceConversationID: source, conversationID: self.conversationID, expectedToken: token) }
    }
    func remove(_ entry: KnowledgeEntry, scope: String) async {
        await mutate { api, token in _ = try await api.editKnowledge(entry.id, scope: scope, kind: nil, text: nil, sourceConversationID: entry.sourceConversationId, conversationID: self.conversationID, expectedToken: token) }
    }
    func propose(_ entry: KnowledgeEntry) async {
        await mutate { api, token in try await api.proposeKnowledge(entry.id, conversationID: self.conversationID, expectedToken: token) }
    }
    func decide(_ proposal: KnowledgeProposal, accept: Bool) async {
        await mutate { api, token in try await api.decideKnowledge(proposal.id, accept: accept, expectedToken: token) }
    }
}

/// Какую запись правит владелец: новая или существующая, в диалоге или в проекте.
struct KnowledgeDraft: Identifiable {
    let id = UUID()
    let scope: String
    var entryID: String
    var kind: String
    var text: String
    var source: String? = nil
    let isNew: Bool
    static func fresh(scope: String) -> KnowledgeDraft {
        KnowledgeDraft(scope: scope, entryID: "owner-" + String(UUID().uuidString.prefix(8)).lowercased(), kind: "fact", text: "", isNew: true)
    }
}

enum KnowledgeSourceLabel {
    static func author(_ source: KnowledgeSource) -> String {
        if source.role == "user" { return "Вы" }
        return AgentRole.name(source.agentKey)
    }
    static func caption(_ source: KnowledgeSource, current: String) -> String {
        var parts = [author(source)]
        if let created = source.created, created > 0 {
            parts.append(Date(timeIntervalSince1970: created / 1000).formatted(date: .abbreviated, time: .shortened))
        }
        if source.conversationId != current { parts.append("диалог «\(source.conversationTitle)»") }
        return parts.joined(separator: " · ")
    }
}

struct KnowledgeView: View {
    @StateObject private var model: KnowledgeModel
    @State private var projectTitle = ""
    @State private var creatingProject = false
    @State private var draft: KnowledgeDraft?
    private let onOpenSource: ((String, String) -> Void)?
    init(server: String, conversationID: String, onOpenSource: ((String, String) -> Void)? = nil) {
        _model = StateObject(wrappedValue: KnowledgeModel(server: server, conversationID: conversationID))
        self.onOpenSource = onOpenSource
    }
    #if DEBUG
    init(preview: KnowledgeModel) { _model = StateObject(wrappedValue: preview); onOpenSource = nil }
    #endif
    private var disabled: Bool { model.loading || model.working || model.needsRefresh }
    var body: some View {
        List {
            if let error = model.error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.secondary)
                    Button("Обновить память") { Task { await model.refresh() } }.disabled(model.loading || model.working)
                }
            }
            if let snapshot = model.snapshot {
                Section {
                    Menu {
                        Button("Без проекта") { Task { await model.assign(nil) } }
                        ForEach(model.projects) { project in
                            Button(project.title) { Task { await model.assign(project.id) } }
                        }
                        Divider()
                        Button("Новый проект…", systemImage: "folder.badge.plus") { creatingProject = true }
                    } label: {
                        HStack {
                            Label("Проект", systemImage: "folder")
                            Spacer()
                            Text(snapshot.project?.title ?? "Без проекта").foregroundStyle(.secondary)
                            Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.secondary)
                        }.frame(minHeight: 44)
                    }.disabled(disabled)
                    statusRow(snapshot.memoryState)
                } footer: {
                    Text("Агенты сами записывают, исправляют и удаляют память. Смахните запись влево, чтобы изменить или удалить её.")
                }
                Section {
                    if snapshot.entries.isEmpty { Text("Пока пусто. Агенты запомнят факты, решения и задачи из разговора.").foregroundStyle(.secondary) }
                    ForEach(snapshot.entries) { entry in
                        row(entry)
                            .swipeActions(edge: .trailing) {
                                Button("Удалить", systemImage: "trash", role: .destructive) { Task { await model.remove(entry, scope: "conversation") } }
                                Button("Изменить", systemImage: "pencil") { draft = KnowledgeDraft(scope: "conversation", entryID: entry.id, kind: entry.kind, text: entry.text, isNew: false) }.tint(.gray)
                            }
                            .contextMenu {
                                Button("Изменить", systemImage: "pencil") { draft = KnowledgeDraft(scope: "conversation", entryID: entry.id, kind: entry.kind, text: entry.text, isNew: false) }
                                if snapshot.project != nil {
                                    Button("В память проекта", systemImage: "arrow.up.doc") { Task { await model.save(entry.id, scope: "project", kind: entry.kind, text: entry.text) } }
                                }
                                Button("Удалить", systemImage: "trash", role: .destructive) { Task { await model.remove(entry, scope: "conversation") } }
                            }
                    }
                    Button("Добавить запись", systemImage: "plus") { draft = .fresh(scope: "conversation") }.disabled(disabled || snapshot.entries.count >= 24)
                } header: { Text("Этот диалог · \(snapshot.entries.count)") }
                if let project = snapshot.project {
                    if !snapshot.proposals.isEmpty {
                        Section("Ждут решения") {
                            ForEach(snapshot.proposals) { proposal in
                                VStack(alignment: .leading, spacing: 8) {
                                    row(proposal.entry)
                                    HStack(spacing: 24) {
                                        Button("Принять", systemImage: "checkmark") { Task { await model.decide(proposal, accept: true) } }
                                        Button("Отклонить", systemImage: "xmark") { Task { await model.decide(proposal, accept: false) } }
                                    }.buttonStyle(.borderless).font(.subheadline).frame(minHeight: 36).disabled(disabled)
                                }
                            }
                        }
                    }
                    Section {
                        if snapshot.projectEntries.isEmpty { Text("Общих записей пока нет. Агенты перенесут сюда то, что важно для всего проекта.").foregroundStyle(.secondary) }
                        ForEach(snapshot.projectEntries, id: \.projectIdentity) { entry in
                            row(entry, shared: entry.sourceConversationId != model.conversationID)
                                .swipeActions(edge: .trailing) {
                                    Button("Удалить", systemImage: "trash", role: .destructive) { Task { await model.remove(entry, scope: "project") } }
                                    Button("Изменить", systemImage: "pencil") { draft = KnowledgeDraft(scope: "project", entryID: entry.id, kind: entry.kind, text: entry.text, source: entry.sourceConversationId, isNew: false) }.tint(.gray)
                                }
                        }
                        Button("Добавить в проект", systemImage: "plus") { draft = .fresh(scope: "project") }.disabled(disabled || snapshot.projectEntries.count >= 100)
                    } header: { Text("Проект «\(project.title)» · \(snapshot.projectEntries.count)") }
                }
            } else if !model.loading && model.error == nil {
                Text("Память ещё не загружена").foregroundStyle(.secondary)
            }
            if model.loading || model.working { HStack { ProgressView(); Text(model.working ? "Сохраняю…" : "Загружаю память…").foregroundStyle(.secondary) } }
        }
        .navigationTitle("Память")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Обновить память").disabled(model.loading || model.working) } }
        .task {
            await model.refresh()
            while !Task.isCancelled && model.snapshot?.memoryState?.state == "updating" {
                do { try await Task.sleep(for: .seconds(3)) } catch { break }
                await model.refresh()
            }
        }
        .refreshable { await model.refresh() }
        .alert("Новый проект", isPresented: $creatingProject) {
            TextField("Название", text: $projectTitle)
            Button("Создать") {
                let title = projectTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !title.isEmpty, title.utf16.count <= 100 else { return }
                Task { await model.createProject(title); if model.error == nil { projectTitle = "" } }
            }
            Button("Отмена", role: .cancel) { projectTitle = "" }
        } message: { Text("Потом выберите его в меню «Проект».") }
        .sheet(item: $draft) { item in
            KnowledgeEditor(draft: item) { saved in
                draft = nil
                Task { await model.save(saved.entryID, scope: saved.scope, kind: saved.kind, text: saved.text, source: saved.source) }
            }
        }
    }
    @ViewBuilder private func statusRow(_ state: KnowledgeMemoryState?) -> some View {
        if let state {
            if state.state == "updating" {
                Label("Агенты обновляют память…", systemImage: "clock").font(.callout).foregroundStyle(.secondary)
            } else if ["error", "interrupted", "stale"].contains(state.state) {
                Label("Последнее обновление не удалось. Сохранённое на месте, следующий ответ обновит память.", systemImage: "exclamationmark.circle").font(.callout).foregroundStyle(.secondary)
            } else if state.updated > 0 {
                Label("Обновлено " + Date(timeIntervalSince1970: state.updated / 1000).formatted(.relative(presentation: .named)), systemImage: "checkmark.circle").font(.callout).foregroundStyle(.secondary)
            }
        }
    }
    private func row(_ entry: KnowledgeEntry, shared: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: entry.kindIcon).foregroundStyle(.secondary).frame(width: 20)
            VStack(alignment: .leading, spacing: 4) {
                Text(entry.text).textSelection(.enabled)
                Text(([entry.kindLabel] + (entry.pinned == true ? ["записано вручную"] : []) + (shared ? ["из другого диалога"] : [])).joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
                if !entry.sourceMessageIds.isEmpty {
                    DisclosureGroup("Источник") {
                        ForEach(entry.sourceMessageIds, id: \.self) { id in sourceRow(id) }
                    }.font(.caption).foregroundStyle(.secondary)
                }
            }
        }.padding(.vertical, 2)
    }
    @ViewBuilder private func sourceRow(_ id: String) -> some View {
        if let source = model.snapshot?.sources?[id] {
            VStack(alignment: .leading, spacing: 4) {
                Text(KnowledgeSourceLabel.caption(source, current: model.conversationID)).font(.caption2).foregroundStyle(.secondary)
                Text(source.excerpt).font(.caption).foregroundStyle(.primary).textSelection(.enabled)
                if let onOpenSource {
                    Button("Открыть в диалоге", systemImage: "arrow.turn.down.right") { onOpenSource(source.conversationId, id) }
                        .buttonStyle(.borderless).font(.caption).frame(minHeight: 36)
                }
            }.padding(.vertical, 2)
        } else {
            Text("Сообщение удалено").font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct KnowledgeEditor: View {
    @State var draft: KnowledgeDraft
    let onSave: (KnowledgeDraft) -> Void
    @Environment(\.dismiss) private var dismiss
    private var trimmed: String { draft.text.trimmingCharacters(in: .whitespacesAndNewlines) }
    var body: some View {
        NavigationStack {
            Form {
                Picker("Вид", selection: $draft.kind) {
                    Text("Факт").tag("fact"); Text("Решение").tag("decision"); Text("Задача").tag("task")
                }.pickerStyle(.segmented).listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                Section {
                    TextField("Что запомнить", text: $draft.text, axis: .vertical).lineLimit(3...10)
                } footer: { Text("\(trimmed.count)/600" + (draft.scope == "project" ? " · увидят все диалоги проекта" : "")) }
            }
            .navigationTitle(draft.isNew ? "Новая запись" : "Изменить запись")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Сохранить") { var value = draft; value.text = trimmed; onSave(value) }.disabled(trimmed.isEmpty || trimmed.count > 600)
                }
            }
        }.presentationDetents([.medium, .large])
    }
}

#if DEBUG
struct KnowledgePreview: View {
    var body: some View {
        let json = #"{"revision":3,"entries":[{"id":"call","kind":"decision","text":"Созвон команды — по вторникам в 11:00","sourceMessageIds":["a"],"pinned":true},{"id":"db","kind":"fact","text":"Хранилище — SQLite на сервере","sourceMessageIds":["b"]},{"id":"report","kind":"task","text":"Подготовить отчёт по продажам к пятнице","sourceMessageIds":["c"]}],"project":{"id":"p","title":"Агент"},"projectEntries":[{"id":"stack","kind":"fact","text":"Бэкенд на Bun, приложение на SwiftUI","sourceMessageIds":["d"],"sourceConversationId":"other"}],"proposals":[],"memoryState":{"state":"ready","updated":\(Int(Date().timeIntervalSince1970 * 1000) - 120000)}}"#
        let snapshot = try! JSONDecoder().decode(KnowledgeSnapshot.self, from: Data(json.utf8))
        return NavigationStack { KnowledgeView(preview: KnowledgeModel(preview: snapshot, projects: [KnowledgeProject(id: "p", title: "Агент")])) }.tint(.primary)
    }
}
#endif
