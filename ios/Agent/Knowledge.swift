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
        guard !loading, !working else { return }
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
    func propose(_ entry: KnowledgeEntry) async {
        await mutate { api, token in try await api.proposeKnowledge(entry.id, conversationID: self.conversationID, expectedToken: token) }
    }
    func decide(_ proposal: KnowledgeProposal, accept: Bool) async {
        await mutate { api, token in try await api.decideKnowledge(proposal.id, accept: accept, expectedToken: token) }
    }
}

struct KnowledgeView: View {
    @StateObject private var model: KnowledgeModel
    @State private var projectTitle = ""
    init(server: String, conversationID: String) {
        _model = StateObject(wrappedValue: KnowledgeModel(server: server, conversationID: conversationID))
    }
    private var disabled: Bool { model.loading || model.working || model.needsRefresh }
    var body: some View {
        List {
            if let error = model.error {
                Section {
                    Text(error).font(.callout).foregroundStyle(.secondary)
                    Button("Обновить память") { Task { await model.refresh() } }.disabled(model.loading || model.working)
                }
            }
            if let snapshot = model.snapshot {
                if let state = snapshot.memoryState {
                    Section {
                        if state.state == "updating" { Label("Обновляю выжимку…", systemImage: "clock") }
                        else if ["error", "interrupted", "stale"].contains(state.state) {
                            Label("Последнюю выжимку не удалось обновить. Сохранённая память доступна; следующая беседа обновит её.", systemImage: "exclamationmark.circle")
                        }
                        if state.updated > 0 {
                            Text("Последняя попытка: " + Date(timeIntervalSince1970: state.updated / 1000).formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary)
                        }
                    }.font(.callout).foregroundStyle(.secondary)
                }
                Section {
                    Menu {
                        Button("Без проекта") { Task { await model.assign(nil) } }
                        ForEach(model.projects) { project in
                            Button(project.title) { Task { await model.assign(project.id) } }
                        }
                    } label: {
                        HStack { Label("Проект", systemImage: "folder"); Spacer(); Text(snapshot.project?.title ?? "Без проекта").foregroundStyle(.secondary); Image(systemName: "chevron.up.chevron.down").font(.caption) }
                            .frame(minHeight: 44)
                    }.disabled(disabled)
                    TextField("Название нового проекта", text: $projectTitle).disabled(disabled)
                    Button("Создать проект") {
                        let title = projectTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task { await model.createProject(title); if model.error == nil { projectTitle = "" } }
                    }.disabled(disabled || projectTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || projectTitle.utf16.count > 100)
                } header: { Text("Проект диалога") } footer: {
                    Text("Объединяйте диалоги вручную. После создания выберите проект. Общая память пополняется только после вашего подтверждения.")
                }
                Section {
                    if snapshot.entries.isEmpty { Text("После содержательного разговора здесь появятся факты, решения и задачи.").foregroundStyle(.secondary) }
                    ForEach(snapshot.entries) { entry in
                        VStack(alignment: .leading, spacing: 10) {
                            entryContent(entry)
                            if snapshot.project != nil {
                                Button("Предложить в память проекта", systemImage: "arrow.up.doc") { Task { await model.propose(entry) } }.buttonStyle(.borderless).font(.subheadline).frame(minHeight: 44).disabled(disabled)
                            }
                        }.padding(.vertical, 4)
                    }
                } header: { Text("Память этого диалога") } footer: { Text("Краткая выжимка с источниками. Полная переписка остаётся в диалоге.") }
                if let project = snapshot.project {
                    Section("Предложения для проекта") {
                        let pending = snapshot.proposals
                        if pending.isEmpty { Text("Нет предложений на проверку").foregroundStyle(.secondary) }
                        ForEach(pending) { proposal in
                            VStack(alignment: .leading, spacing: 10) {
                                Text(proposal.entry.text).textSelection(.enabled)
                                sources(proposal.entry.sourceMessageIds)
                                HStack(spacing: 24) {
                                    Button("Принять", systemImage: "checkmark") { Task { await model.decide(proposal, accept: true) } }
                                    Button("Отклонить", systemImage: "xmark") { Task { await model.decide(proposal, accept: false) } }
                                }.buttonStyle(.borderless).frame(minHeight: 44).disabled(disabled)
                            }.padding(.vertical, 4)
                        }
                    }
                    Section {
                        if snapshot.projectEntries.isEmpty { Text("Подтверждённых записей пока нет").foregroundStyle(.secondary) }
                        ForEach(snapshot.projectEntries, id: \.projectIdentity) { entry in entryContent(entry).padding(.vertical, 4) }
                    } header: { Text("Общая память · " + project.title) }
                }
            } else if !model.loading && model.error == nil {
                Text("Память ещё не загружена").foregroundStyle(.secondary)
            }
            if model.loading || model.working { HStack { ProgressView(); Text(model.working ? "Сохраняю…" : "Загружаю память…").foregroundStyle(.secondary) } }
        }
        .navigationTitle("Память диалога")
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
    }
    private func entryContent(_ entry: KnowledgeEntry) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(entry.kindLabel).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(entry.text).textSelection(.enabled)
            sources(entry.sourceMessageIds)
        }
    }
    @ViewBuilder private func sources(_ ids: [String]) -> some View {
        if !ids.isEmpty {
            DisclosureGroup("Источники · \(ids.count)") {
                ForEach(Array(ids.enumerated()), id: \.offset) { _, id in Text(id).font(.caption.monospaced()).textSelection(.enabled).foregroundStyle(.secondary) }
            }.font(.caption).foregroundStyle(.secondary)
        }
    }
}
