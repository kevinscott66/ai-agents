import SwiftUI
import AVFoundation
import PhotosUI
import UniformTypeIdentifiers

struct ChatLine: Identifiable, Codable {
    var id = UUID().uuidString; let role: String; let text: String
    var agentKey: String? = nil
    /// Когда сообщение отправлено или получено, миллисекунды Unix.
    var created: Double? = nil
    var attachments: [NativeAttachment]? = nil
    var location: SharedLocation? = nil
}
@MainActor final class ChatModel: ObservableObject {
    @Published var lines: [ChatLine] = []
    @Published var busy = false
    @Published var pending = UserDefaults.standard.string(forKey: "pendingTurn") != nil && UserDefaults.standard.string(forKey: "pendingServer") != nil
    @Published var error: String?
    @Published var draft = ""
    @Published var attachments: [AttachmentDraft] = []
    @Published var location: SharedLocation?
    @Published var uploadStatus: String?
    @Published var generations: [NativeGeneration] = []
    private var recovering = false
    @Published var newReplyForSpeech: ChatLine?
    @Published private(set) var attachmentGeneration = UUID()
    func clearMedia() { attachments = []; location = nil; attachmentGeneration = UUID() }

    @Published var conversations: [ConversationRecord] = []
    @Published var moreConversations = false
    private var conversationCursor: String?
    private var loadedMoreConversations = false
    @Published var conversationId: String?
    @Published var moreHistory = false
    @Published var remoteBusy = false
    private var boundServer = ""
    private var boundToken: String?
    @Published var historyError: String?
    private var fresh = false
    private var firstSequence: Int?
    private var syncing = false
    private var syncGeneration = UUID()
    private func bind(server: String) {
        let token = Credentials.read(server: server)
        if boundServer != server || boundToken != token {
            operation = UUID(); polling?.cancel(); polling = nil; busy = false
            let previousServer = boundServer
            syncGeneration = UUID(); boundServer = server; boundToken = token
            conversationCursor = nil; moreConversations = false; loadedMoreConversations = false
            if !previousServer.isEmpty { clearMedia() }; lines = []; generations = []; conversations = []; fresh = false; firstSequence = nil; moreHistory = false; remoteBusy = false
            conversationId = UserDefaults.standard.string(forKey: "conversation:" + server)
        }
    }
    func newConversation(server: String) {
        guard !busy, !pending else { return }
        bind(server: server)
        clearMedia()
        syncGeneration = UUID(); conversationId = nil; lines = []; generations = []; draft = ""; fresh = true; moreHistory = false; firstSequence = nil
        UserDefaults.standard.removeObject(forKey: "conversation:" + server)
    }
    func selectConversation(_ id: String, server: String) async {
        guard !busy, !pending else { return }
        bind(server: server)
        clearMedia()
        syncGeneration = UUID(); conversationId = id; fresh = false; lines = []; generations = []; draft = ""; firstSequence = nil; moreHistory = false
        UserDefaults.standard.set(id, forKey: "conversation:" + server)
        await synchronize(server: server)
    }
    func synchronize(server: String, older: Bool = false) async {
        bind(server: server)
        guard !busy, !pending, !syncing, let token = boundToken else { return }
        let generation = syncGeneration
        syncing = true; defer { syncing = false }
        do {
            let index = try await AgentAPI(server: server).conversations(expectedToken: token)
            guard generation == syncGeneration, Credentials.read(server: server) == token, !busy, !pending else { return }
            let list = index.conversations
            mergeConversations(list); remoteBusy = index.running
            if !loadedMoreConversations { conversationCursor = index.nextCursor; moreConversations = index.more }
            if let id = conversationId, !index.more, !conversations.contains(where: { $0.id == id }) { conversationId = nil; lines = []; firstSequence = nil }
            if conversationId == nil && !fresh { conversationId = list.first?.id }
            if let id = conversationId {
                let history = try await AgentAPI(server: server).history(id, before: older ? firstSequence : nil, expectedToken: token)
                guard generation == syncGeneration, Credentials.read(server: server) == token, conversationId == id, !busy, !pending else { return }
                let incoming = history.messages.map { ChatLine(id:$0.id,role:$0.role == "user" ? "Вы" : "Агент",text:$0.text,agentKey:$0.agentKey,created:$0.created,attachments:$0.attachments,location:$0.location) }
                if older {
                    let ids = Set(lines.map(\.id)); lines = incoming.filter { !ids.contains($0.id) } + lines
                    firstSequence = history.messages.first?.seq ?? firstSequence; moreHistory = history.more
                } else {
                    // Retain already loaded older pages while replacing the current server window.
                    let first = incoming.first.flatMap { item in lines.firstIndex(where: { $0.id == item.id }) }
                    lines = (first.map { Array(lines.prefix($0)) } ?? []) + incoming
                    if firstSequence == nil || first == nil { firstSequence = history.messages.first?.seq; moreHistory = history.more }
                }
                generations = history.generations ?? []
                remoteBusy = history.running
                UserDefaults.standard.set(id, forKey:"conversation:" + server)
            }
            historyError = nil
        } catch { if generation == syncGeneration { historyError = "Не удалось синхронизировать диалоги: " + error.localizedDescription } }
    }
    private func mergeConversations(_ incoming: [ConversationRecord]) {
        let incomingIDs = Set(incoming.map(\.id))
        conversations = (incoming + conversations.filter { !incomingIDs.contains($0.id) }).sorted {
            $0.updated == $1.updated ? $0.id > $1.id : $0.updated > $1.updated
        }
    }
    @Published var archived: [ConversationRecord] = []
    func loadArchived(server: String) async {
        bind(server: server)
        guard let token = boundToken else { return }
        do { archived = try await AgentAPI(server: server).conversations(archived: true, expectedToken: token).conversations; historyError = nil }
        catch { historyError = "Не удалось загрузить архив: " + error.localizedDescription }
    }
    /// Переименовать, убрать в архив или вернуть из него. Список обновляется сразу, сервер — следом.
    func editConversation(_ id: String, title: String? = nil, archived toArchive: Bool? = nil, server: String) async {
        bind(server: server)
        guard let token = boundToken else { return }
        do {
            try await AgentAPI(server: server).editConversation(id, title: title, archived: toArchive, expectedToken: token)
            if let title {
                let name = AgentAPI.conversationTitle(title.trimmingCharacters(in: .whitespacesAndNewlines))
                conversations = conversations.map { $0.id == id ? ConversationRecord(id: $0.id, title: name, updated: $0.updated, archived: $0.archived) : $0 }
                archived = archived.map { $0.id == id ? ConversationRecord(id: $0.id, title: name, updated: $0.updated, archived: $0.archived) : $0 }
            }
            if toArchive == true {
                conversations.removeAll { $0.id == id }
                if conversationId == id, !busy, !pending { newConversation(server: server) }
            }
            if toArchive == false { archived.removeAll { $0.id == id } }
            historyError = nil
            await synchronize(server: server)
        } catch { historyError = "Не удалось изменить диалог: " + error.localizedDescription }
    }
    func deleteConversation(_ id: String, server: String) async {
        bind(server: server)
        guard let token = boundToken, !(conversationId == id && (busy || pending)) else { historyError = "Дождитесь ответа в этом диалоге"; return }
        do {
            try await AgentAPI(server: server).deleteConversation(id, expectedToken: token)
            conversations.removeAll { $0.id == id }; archived.removeAll { $0.id == id }
            if conversationId == id { newConversation(server: server) }
            historyError = nil
        } catch { historyError = "Не удалось удалить диалог: " + error.localizedDescription }
    }
    func loadMoreConversations(server: String) async {
        bind(server: server)
        guard !busy, !pending, !syncing, moreConversations, let cursor = conversationCursor, let token = boundToken else { return }
        let generation = syncGeneration
        syncing = true; defer { syncing = false }
        do {
            let index = try await AgentAPI(server: server).conversations(cursor: cursor, expectedToken: token)
            guard generation == syncGeneration, Credentials.read(server: server) == token else { return }
            mergeConversations(index.conversations)
            conversationCursor = index.nextCursor; moreConversations = index.more; loadedMoreConversations = true
            remoteBusy = index.running; historyError = nil
        } catch { if generation == syncGeneration { historyError = "Не удалось загрузить диалоги: " + error.localizedDescription } }
    }
    private var polling: Task<Void, Never>?
    private var currentReplies = 0
    private var currentTurn: String?
    private var operation = UUID()
    @discardableResult func send(server: String) -> Bool {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!text.isEmpty || !attachments.isEmpty || location != nil), !busy, !remoteBusy else { return false }
        guard text.utf16.count <= 8_000 else { error = "Сообщение слишком длинное. Сократите его до 8000 символов."; return false }
        guard !pending else { error = "Сначала проверьте ответ на предыдущий запрос."; return false }
        bind(server: server)
        guard let token = boundToken else { error = "Подключите устройство в настройках"; return false }
        let media = attachments; let place = location
        let dialogID = conversationId ?? UUID().uuidString
        conversationId = dialogID; fresh = false; syncGeneration = UUID()
        UserDefaults.standard.set(dialogID, forKey: "conversation:" + server)
        let id = UUID().uuidString
        draft = ""; clearMedia(); error = nil; recovering = false; busy = true; pending = true; currentReplies = 0; currentTurn = id
        lines.append(ChatLine(id: id + ":user", role: "Вы", text: text, created: Date().timeIntervalSince1970 * 1000, attachments: media.map(\.metadata), location: place))
        // Save the request ID before sending. A reconnect only polls this ID.
        UserDefaults.standard.set(id, forKey: "pendingTurn")
        UserDefaults.standard.set(server, forKey: "pendingServer")
        UserDefaults.standard.set(dialogID, forKey: "pendingConversation")
        let activeOperation = UUID()
        operation = activeOperation
        polling = Task {
            var submitted = false
            do {
                try await AgentAPI(server: server).createConversation(dialogID, title: text.isEmpty ? (media.first?.name ?? "Геопозиция") : text, expectedToken: token)
                try Task.checkCancellation()
                for (index, item) in media.enumerated() {
                    uploadStatus = "Загрузка \(index + 1) из \(media.count)…"
                    _ = try await AgentAPI(server: server).upload(item, expectedToken: token)
                    try Task.checkCancellation()
                }
                uploadStatus = nil
                submitted = true
                let first = try await AgentAPI(server: server).send(text, id: id, conversationId: dialogID, expectedToken: token, attachmentIds: media.map(\.id), location: place)
                try Task.checkCancellation()
                guard boundServer == server, boundToken == token, Credentials.read(server: server) == token else { throw AgentError.message("Подключение изменилось") }
                consume(first)
                if first.status == "running" { try await watch(server: server, id: id, token: token) }
            } catch is CancellationError { } catch {
                guard operation == activeOperation, !Task.isCancelled else { return }
                if !submitted || error is TurnRejected { submitted = false; clearPending(); draft = text; attachments = media; location = place; lines.removeAll { $0.id == id + ":user" } }
                uploadStatus = nil
                self.error = error.localizedDescription + (submitted ? " Если запрос принят сервером, нажмите «Проверить ответ»." : ""); busy = false }
        }
        return true
    }
    func resume() {
        guard !busy else { return }
        guard let pendingServer = UserDefaults.standard.string(forKey: "pendingServer"),
              let id = UserDefaults.standard.string(forKey: "pendingTurn") else { clearPending(); return }
        bind(server: pendingServer)
        guard let token = boundToken else { error = "Подключите устройство в настройках"; return }
        conversationId = UserDefaults.standard.string(forKey:"pendingConversation")
        boundServer = pendingServer
        if currentTurn != id { currentReplies = 0; currentTurn = id }
        error = nil; busy = true; recovering = true
        let activeOperation = UUID()
        operation = activeOperation
        polling = Task {
            do { try await watch(server: pendingServer, id: id, token: token) }
            catch is CancellationError { }
            catch {
                guard operation == activeOperation, !Task.isCancelled else { return }
                self.error = error.localizedDescription; busy = false
            }
        }
    }
    private func watch(server: String, id: String, token: String) async throws {
        for _ in 0..<300 {
            try Task.checkCancellation()
            let result = try await AgentAPI(server: server).poll(id, expectedToken: token)
            try Task.checkCancellation()
            guard boundServer == server, boundToken == token, Credentials.read(server: server) == token else { throw AgentError.message("Подключение изменилось") }
            consume(result)
            if result.status != "running" { return }
            try await Task.sleep(for: .seconds(2))
        }
        busy = false
        error = "Запрос ещё выполняется. Нажмите «Проверить ответ» позже."
    }
    private func consume(_ turn: Turn) {
        let newReplies = Array(turn.replies.enumerated().dropFirst(currentReplies))
        for (index, text) in turn.replies.enumerated() {
            let id = turn.id + ":reply:" + String(index + 1)
            let media = turn.outputMedia?.first(where: { $0.messageId == id })?.attachments
            let existing = lines.firstIndex(where: { $0.id == id })
            let line = ChatLine(id: id, role: "Агент", text: text, agentKey: turn.replyDetails?.first(where: { $0.messageId == id })?.agentKey,
                                created: existing.flatMap { lines[$0].created } ?? Date().timeIntervalSince1970 * 1000, attachments: media)
            if let existing { lines[existing] = line }
            else { lines.append(line) }
        }
        if let jobs = turn.generations {
            let ids = Set(jobs.map(\.id))
            generations = generations.filter { !ids.contains($0.id) } + jobs
        }
        if !recovering && !newReplies.isEmpty {
            let text = newReplies.map { $0.element }.filter { !$0.isEmpty }.joined(separator: "\n\n")
            if !text.isEmpty { newReplyForSpeech = ChatLine(id: turn.id + ":speech:" + String(turn.replies.count), role: "Агент", text: text) }
        }
        currentReplies = turn.replies.count
        if turn.status != "running" {
            busy = false; clearPending()
            if turn.status == "interrupted" { error = "Сервер перезапущен. Задача могла выполнить часть действий — уточните её состояние." }
        }
    }
    private func clearPending() {
        pending = false
        for key in ["pendingTurn", "pendingServer", "pendingConversation"] { UserDefaults.standard.removeObject(forKey: key) }
    }
    func abandonWaiting() {
        operation = UUID()
        polling?.cancel(); polling = nil; busy = false; pending = false
        clearPending()
        error = "Ожидание сброшено. Серверная задача могла продолжить работу; перед повтором проверьте её состояние."
    }
    func speak(_ text: String) { VoiceOutput.shared.speak(text) }
    func stopSpeech() { VoiceOutput.shared.stop() }

}

struct AgentGlass: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduced
    let radius: CGFloat
    @ViewBuilder func body(content: Content) -> some View {
        if reduced {
            content.background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: radius))
        } else if #available(iOS 26.0, *) {
            content.glassEffect(.regular, in: RoundedRectangle(cornerRadius: radius))
        } else {
            content.background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: radius))
        }
    }
}
@main struct AgentApp: App {
    var body: some Scene { WindowGroup {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--generation-preview") { GenerationPreview() }
        else if ProcessInfo.processInfo.arguments.contains("--media-selftest") { MediaSelfTestView() }
        else if ProcessInfo.processInfo.arguments.contains("--connection-preview") { NavigationStack { SettingsView(server: .constant("https://agent.example.com")) }.tint(.primary) }
        else if ProcessInfo.processInfo.arguments.contains("--voice-settings-preview") { NavigationStack { VoiceSettingsView() }.tint(.primary) }
        else if ProcessInfo.processInfo.arguments.contains("--openflux-probe") { OpenFluxProbeView() }
        else if ProcessInfo.processInfo.arguments.contains("--approval-preview") { ChatApprovalPreview() }
        else if ProcessInfo.processInfo.arguments.contains("--panel-sheet-preview") { PanelSheetPreview() }
        else if ProcessInfo.processInfo.arguments.contains("--panel-preview") {
            NavigationStack { PanelView(server: "https://agent.invalid") }.tint(.primary)
        } else { RootView().tint(.primary) }
        #else
        RootView().tint(.primary)
        #endif
    } }
}
struct RootView: View {
    @StateObject private var model = ChatModel()
    @StateObject private var voice = VoiceInput()
    @State private var conversationVoice = false
    @StateObject private var locator = LocationPicker()
    @ObservedObject private var speech = VoiceOutput.shared
    @State private var photos: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var showCamera = false
    @State private var mediaLoading = false
    @State private var preparationTask: Task<Void, Never>?
    @State private var activeMediaJob: UUID?

    @StateObject private var approvals = ChatApprovals()
    @StateObject private var signing = SignedActionsModel()
    // Адреса сервера по умолчанию нет: репозиторий публичный, адрес задаётся при подключении.
    @AppStorage("server") private var server = ""
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    @FocusState private var typing: Bool
    @State private var menu = false
    @State private var actions = false
    @State private var settings = false
    @State private var abandon = false
    @State private var renaming: ConversationRecord?
    @State private var renameText = ""
    @State private var deleting: ConversationRecord?
    private static func restoredServer() -> String? {
        if let pending = UserDefaults.standard.string(forKey: "pendingServer"), Credentials.read(server: pending) != nil { return pending }
        return Credentials.pairedServers().first { Credentials.read(server: $0) != nil }
    }
    private var canvas: Color { Color(uiColor: .systemBackground) }
    private var ink: Color { scheme == .dark ? .white : Color(white: 0.05) }
    private var inverseInk: Color { scheme == .dark ? .black : .white }
    var body: some View {
        NavigationStack {
            chat
                .navigationTitle("Агент")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { menu = true } label: { Image(systemName: "line.3.horizontal").font(.system(size: 19, weight: .medium)) }.accessibilityLabel("Открыть меню")
                    }
                    ToolbarItem(placement: .topBarTrailing) { OpenFluxQuickToggle(server: server) }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { voice.stop(); model.newConversation(server: server); typing = true } label: { Image(systemName: "square.and.pencil").font(.system(size: 20, weight: .regular)) }.disabled(model.busy || model.pending).accessibilityLabel("Новый диалог")
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) { composer }
                .background(canvas)
        }
        // Restart when foreground state changes; a long-lived task otherwise captures
        // the initial inactive ScenePhase and never starts fetching confirmations.
        .task(id: server + (scenePhase == .active ? "|active" : "|inactive")) {
            while !Task.isCancelled {
                if scenePhase == .active { await approvals.refresh(server: server, conversation: model.conversationId); await signing.refresh(server: server); await model.synchronize(server: server) }
                do { try await Task.sleep(for: .seconds(5)) } catch { break }
            }
        }
        .photosPicker(isPresented: $showPhotos, selection: $photos, maxSelectionCount: 4, matching: .any(of: [.images, .videos]))
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result { case .success(let urls): importFiles(urls); case .failure(let error): model.error = error.localizedDescription }
        }
        .sheet(isPresented: $showCamera) { CameraPicker { image in
            showCamera = false
            guard let image, let data = image.jpegData(compressionQuality: 0.9) else { return }
            do { if model.attachments.count < 4 { model.attachments.append(try MediaPreparation.photo(data)) } } catch { model.error = error.localizedDescription }
        }.ignoresSafeArea() }
        .sheet(isPresented: $conversationVoice) { ConversationVoiceView(model: model, server: server) }
        .onChange(of: photos) { _, items in importPhotos(items) }
        .onChange(of: model.newReplyForSpeech?.id) { _, _ in
            if !conversationVoice, VoiceOutput.autoSpeak, scenePhase == .active, let reply = model.newReplyForSpeech { voice.stop(); speech.enqueue(reply.text) }
        }
        .onChange(of: model.attachmentGeneration) { _, _ in cancelMediaPreparation(); locator.cancel() }
        .onAppear {
            // Builds without a default address: keep an earlier pairing instead of asking to pair again.
            if server.isEmpty, let saved = Self.restoredServer() { server = saved }
            speech.server = server
            if server.isEmpty { settings = true }
        }
        .onChange(of: server) { _, value in speech.server = value; conversationVoice = false; cancelMediaPreparation(); locator.cancel(); voice.stop(); model.stopSpeech() }
        .onChange(of: menu) { _, opened in if opened { voice.stop(); model.stopSpeech() } }
        .onChange(of: actions) { _, opened in if opened { voice.stop(); model.stopSpeech() } }
        .onChange(of: settings) { _, opened in if opened { voice.stop(); model.stopSpeech() } }
        .onChange(of: model.conversationId) { _, conversation in
            locator.cancel(); voice.stop(); model.stopSpeech()
            Task { await approvals.refresh(server: server, conversation: conversation) }
        }
        .onChange(of: model.busy) { _, busy in
            if !busy && scenePhase == .active { Task { await approvals.refresh(server: server, conversation: model.conversationId) } }
        }
        .onChange(of: voice.text) { _, value in model.draft = value }
        .onChange(of: voice.error) { _, value in if let value { model.error = value } }
        .onDisappear { voice.stop(); model.stopSpeech() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { voice.stop(); model.stopSpeech() }
        }
        .sheet(isPresented: $menu) {
            NavigationStack {
                List {
                    Section {
                        Label("Чат с командой", systemImage: "bubble.left.and.bubble.right")
                        if let conversationId = model.conversationId {
                            NavigationLink { KnowledgeView(server: server, conversationID: conversationId) } label: { Label("Память диалога", systemImage: "books.vertical") }
                        }
                        NavigationLink { PanelView(server: server, onMacStart: { project, task, provider, allowFallback in
                            guard !model.busy && !model.pending && !model.remoteBusy else { throw AgentError.message("Дождитесь завершения текущего запроса") }
                            model.draft = PanelMacLaunch.draft(project: project, prompt: task, provider: provider, allowFallback: allowFallback)
                            guard model.send(server: server) else { throw AgentError.message(model.error ?? "Не удалось отправить запрос") }
                        }) } label: { Label("Панель команды", systemImage: "rectangle.grid.2x2") }
                        NavigationLink { ActionsView { choose($0); menu = false } } label: { Label("Все действия", systemImage: "square.grid.2x2") }
                        NavigationLink { SettingsView(server: $server, connectionLocked: !server.isEmpty && model.busy) } label: { Label("Подключение", systemImage: "slider.horizontal.3") }
                    }
                    Section("Диалоги") {
                        if let error = model.historyError { Text(error).font(.caption).foregroundStyle(.secondary) }
                        Button("Новый диалог", systemImage: "square.and.pencil") { voice.stop(); model.newConversation(server: server); menu = false }.disabled(model.busy || model.pending)
                        ForEach(model.conversations) { conversation in
                            Button { voice.stop(); Task { await model.selectConversation(conversation.id, server: server); menu = false } } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(conversation.title).lineLimit(2)
                                    Text(Date(timeIntervalSince1970: conversation.updated / 1000), style: .date).font(.caption).foregroundStyle(.secondary)
                                }
                            }.disabled(model.busy || model.pending)
                            .contextMenu { conversationActions(conversation, archived: false) }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) { deleting = conversation } label: { Label("Удалить", systemImage: "trash") }
                                Button { Task { await model.editConversation(conversation.id, archived: true, server: server) } } label: { Label("В архив", systemImage: "archivebox") }.tint(.indigo)
                            }
                            .swipeActions(edge: .leading) {
                                Button { renaming = conversation; renameText = conversation.title } label: { Label("Переименовать", systemImage: "pencil") }.tint(.blue)
                            }
                        }
                        if model.moreConversations { Button("Предыдущие диалоги") { Task { await model.loadMoreConversations(server: server) } } }
                        Button("Обновить историю") { Task { await model.synchronize(server: server) } }
                        NavigationLink { archiveList } label: { Label("Архив", systemImage: "archivebox") }
                    }
                    Section("Быстрый старт") {
                        Button { choose("Агент, начни мой день"); menu = false } label: { Label("Начать день", systemImage: "sun.max") }
                        Button { choose("Агент, покажи календарь"); menu = false } label: { Label("Календарь", systemImage: "calendar") }
                        Button { choose("Агент, подведи итоги дня"); menu = false } label: { Label("Итоги дня", systemImage: "moon") }
                    }
                    Section { Text("Один собеседник. Команда из 12 ролей.").font(.footnote).foregroundStyle(.secondary) }
                }.navigationTitle("Агент").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { menu = false } } }
            }
            .alert("Переименовать диалог", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Название", text: $renameText)
                Button("Отмена", role: .cancel) { renaming = nil }
                Button("Сохранить") {
                    let name = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                    if let item = renaming, !name.isEmpty { Task { await model.editConversation(item.id, title: name, server: server) } }
                    renaming = nil
                }
            }
            .alert("Удалить диалог?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { item in
                Button("Отмена", role: .cancel) { deleting = nil }
                Button("Удалить", role: .destructive) { Task { await model.deleteConversation(item.id, server: server) }; deleting = nil }
            } message: { item in Text("«\(item.title)» и его память удалятся без возможности вернуть. Чтобы просто убрать из списка, отправьте в архив.") }
            .presentationDetents([.large]).presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $actions) {
            NavigationStack { ActionsView { choose($0); actions = false }.toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { actions = false } } } }
                .presentationDetents([.large]).presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $settings) {
            NavigationStack { SettingsView(server: $server, connectionLocked: !server.isEmpty && model.busy).toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { settings = false } } } }
                .presentationDragIndicator(.visible)
        }
        .alert("Сбросить ожидание?", isPresented: $abandon) {
            Button("Продолжить ждать", role: .cancel) {}
            Button("Сбросить", role: .destructive) { model.abandonWaiting() }
        } message: { Text("Это не остановит работу на сервере. Повтор команды может выполнить действие ещё раз.") }
    }
    /// Черновик сразу пишется распознаванием на устройстве; после стопа сервер присылает
    /// более точный текст, и он заменяет черновик, если тот не правили руками.
    private func startDictation() {
        let target = server
        Task {
            await voice.start(refine: { data in
                guard let token = Credentials.read(server: target) else { throw AgentError.message("Подключите устройство в настройках") }
                return try await AgentAPI(server: target).transcribeVoice(data, expectedToken: token)
            }, apply: { spoken, refined in
                guard server == target, let text = DictationDraft.replacement(draft: model.draft, spoken: spoken, refined: refined) else { return }
                model.draft = text
            })
        }
    }
    private func choose(_ text: String) { voice.stop(); model.draft = text; typing = true }
    private var chat: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if model.remoteBusy && !model.busy { Text("Агент выполняет запрос с другого устройства. Ответ появится в соответствующем диалоге.").font(.footnote).foregroundStyle(.secondary).padding() }
                if model.lines.isEmpty && approvals.visibleItems.isEmpty && signing.items.isEmpty {
                    VStack(spacing: 14) {
                        Spacer(minLength: 140)
                        Text("Чем помочь?").font(.system(size: 30, weight: .semibold)).tracking(-0.7)
                        Text("Работа, планы и повседневные дела").font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        VStack(spacing: 10) {
                            suggestion("Начать день", icon: "sun.max", prompt: "Агент, начни мой день")
                            suggestion("Проверить проекты", icon: "chevron.left.forwardslash.chevron.right", prompt: "Агент, проверь мои проекты и выдели, что требует внимания")
                            Button { actions = true } label: { Label("Повседневные дела", systemImage: "sparkle").font(.subheadline).padding(.horizontal, 16).padding(.vertical, 12) }.buttonStyle(.plain)
                                .overlay(Capsule().stroke(ink.opacity(0.10), lineWidth: 0.7))
                        }.padding(.top, 18)
                        Spacer(minLength: 100)
                    }.frame(maxWidth: .infinity).padding(.horizontal, 24)
                } else {
                    LazyVStack(alignment: .leading, spacing: 26) {
                        if model.moreHistory { Button("Предыдущие сообщения") {
                            let anchor = model.lines.first?.id
                            let conversation = model.conversationId
                            Task {
                                await model.synchronize(server: server, older: true)
                                if model.conversationId == conversation, let anchor { proxy.scrollTo(anchor, anchor: .top) }
                            }
                        } }
                        ForEach(model.lines) { line in
                            if let item = approvals.visibleItems.first(where: { line.id == "approval:" + $0.id + ":result" }) {
                                approvalCard(item)
                            }
                            if line.role == "Вы" {
                                HStack {
                                    Spacer(minLength: 44)
                                    VStack(alignment: .leading, spacing: 8) {
                                        if !line.text.isEmpty { Text(line.text).font(.body).textSelection(.enabled) }
                                        ForEach(line.attachments ?? []) { item in AttachmentRow(attachment: item, server: server) }
                                        if let place = line.location { locationLabel(place) }
                                    }.padding(.horizontal, 18).padding(.vertical, 12).background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 24))
                                }
                                .overlay(alignment: .bottomTrailing) { messageTime(line).offset(y: 18) }
                                .id(line.id)
                            } else {
                                VStack(alignment: .leading, spacing: 12) {
                                    if let key = line.agentKey { Text(AgentRole.name(key)).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary) }
                                    if !line.text.isEmpty { Text(.init(line.text)).font(.body).lineSpacing(5).textSelection(.enabled) }
                                    ForEach(line.attachments ?? []) { item in AttachmentRow(attachment: item, server: server) }
                                    if !line.text.isEmpty { HStack(spacing: 8) {
                                        messageTime(line).padding(.trailing, 4)
                                        Button { UIPasteboard.general.string = line.text } label: { Image(systemName: "doc.on.doc").frame(width: 44, height: 44) }.accessibilityLabel("Скопировать ответ")
                                        Button { voice.stop(); model.speak(line.text) } label: { Image(systemName: "speaker.wave.2").frame(width: 44, height: 44) }.accessibilityLabel("Озвучить ответ")
                                        Button { model.stopSpeech() } label: { Image(systemName: "speaker.slash").frame(width: 44, height: 44) }.accessibilityLabel("Остановить озвучивание")
                                    }.font(.system(size: 15)).foregroundStyle(.secondary) }
                                }.id(line.id)
                            }
                        }
                        ForEach(approvals.visibleItems.filter { item in !model.lines.contains(where: { $0.id == "approval:" + item.id + ":result" }) }) { item in
                            approvalCard(item)
                        }
                        ForEach(signing.items) { item in
                            SignedActionCard(item: item, outcome: signing.outcomes[item.nonce], working: signing.working.contains(item.nonce),
                                             approve: { Task { await signing.approve(item, server: server) } },
                                             reject: { Task { await signing.reject(item, server: server) } }).id("signed-" + item.nonce)
                        }
                        ForEach(model.generations.filter { $0.state != "completed" }) { job in GenerationCanvas(status: job.state).id(job.id) }
                        if model.busy && !model.generations.contains(where: { $0.state == "running" }) { HStack(spacing: 10) { ProgressView(); Text("Агент работает").font(.subheadline).foregroundStyle(.secondary) } }
                    }.padding(.horizontal, 22).padding(.vertical, 24)
                }
            }.scrollDismissesKeyboard(.interactively)
                .onChange(of: approvals.visibleItems.count) { _, _ in
                    if let item = approvals.visibleItems.last { proxy.scrollTo("approval-" + item.id, anchor: .bottom) }
                }
                .onChange(of: model.lines.last?.id) { _, _ in
                    if let id = model.lines.last?.id {
                        if reducedMotion { proxy.scrollTo(id, anchor: .bottom) }
                        else { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(id, anchor: .bottom) } }
                    }
                }
        }
    }
    /// Время как в ChatGPT/Claude: сегодня — часы, раньше — дата и часы.
    @ViewBuilder private func messageTime(_ line: ChatLine) -> some View {
        if let created = line.created {
            let date = Date(timeIntervalSince1970: created / 1000)
            Text(Calendar.current.isDateInToday(date) ? date.formatted(date: .omitted, time: .shortened) : date.formatted(.dateTime.day().month(.abbreviated).hour().minute()))
                .font(.caption2).monospacedDigit().foregroundStyle(.tertiary)
                .accessibilityLabel("Отправлено " + date.formatted(date: .abbreviated, time: .shortened))
        }
    }
    @ViewBuilder private func conversationActions(_ conversation: ConversationRecord, archived: Bool) -> some View {
        Button { renaming = conversation; renameText = conversation.title } label: { Label("Переименовать", systemImage: "pencil") }
        Button { Task { await model.editConversation(conversation.id, archived: !archived, server: server) } } label: {
            Label(archived ? "Вернуть из архива" : "В архив", systemImage: archived ? "tray.and.arrow.up" : "archivebox")
        }
        Button(role: .destructive) { deleting = conversation } label: { Label("Удалить", systemImage: "trash") }
    }
    private var archiveList: some View {
        List {
            if model.archived.isEmpty { Text("Архив пуст").foregroundStyle(.secondary) }
            ForEach(model.archived) { conversation in
                VStack(alignment: .leading, spacing: 4) {
                    Text(conversation.title).lineLimit(2)
                    Text(Date(timeIntervalSince1970: conversation.updated / 1000), style: .date).font(.caption).foregroundStyle(.secondary)
                }
                .contextMenu { conversationActions(conversation, archived: true) }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) { deleting = conversation } label: { Label("Удалить", systemImage: "trash") }
                    Button { Task { await model.editConversation(conversation.id, archived: false, server: server) } } label: { Label("Вернуть", systemImage: "tray.and.arrow.up") }.tint(.indigo)
                }
            }
        }
        .navigationTitle("Архив")
        .task { await model.loadArchived(server: server) }
        .refreshable { await model.loadArchived(server: server) }
    }
    private func approvalCard(_ item: ChatApproval) -> some View {
        ChatApprovalCard(item: item, outcome: approvals.outcomes[item.id], working: approvals.working.contains(item.id)) { approve in
            Task {
                await approvals.decide(item, approve: approve, server: server)
                await model.synchronize(server: server)
            }
        }.id("approval-" + item.id)
    }
    private func suggestion(_ title: String, icon: String, prompt: String) -> some View {
        Button { choose(prompt) } label: { Label(title, systemImage: icon).font(.subheadline).padding(.horizontal, 16).padding(.vertical, 12) }
            .buttonStyle(.plain).overlay(Capsule().stroke(ink.opacity(0.10), lineWidth: 0.7))
    }
    private func locationLabel(_ place: SharedLocation) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Label("Геопозиция", systemImage: "location.fill")
            Text(String(format: "%.5f, %.5f", place.latitude, place.longitude)).font(.caption).textSelection(.enabled)
            if let accuracy = place.accuracy { Text("Точность около \(Int(accuracy)) м").font(.caption2).foregroundStyle(.secondary) }
        }
    }
    private func cancelMediaPreparation() {
        preparationTask?.cancel(); preparationTask = nil; activeMediaJob = nil; mediaLoading = false; photos = []
    }
    private func prepareFile(_ url: URL, name: String? = nil) async throws -> AttachmentDraft {
        let worker = Task.detached(priority: .userInitiated) { try await MediaPreparation.file(url, displayName: name) }
        return try await withTaskCancellationHandler {
            let result = try await worker.value
            try Task.checkCancellation()
            return result
        } onCancel: { worker.cancel() }
    }
    private func importFiles(_ urls: [URL]) {
        guard !mediaLoading else { return }
        let generation = model.attachmentGeneration
        let remaining = max(0, 4 - model.attachments.count)
        guard remaining > 0 else { model.error = "Можно прикрепить до 4 файлов"; return }
        let job = UUID(); activeMediaJob = job; mediaLoading = true
        preparationTask = Task {
            defer { if activeMediaJob == job { mediaLoading = false; preparationTask = nil; activeMediaJob = nil } }
            for url in urls.prefix(remaining) {
                if Task.isCancelled { return }
                do {
                    let item = try await prepareFile(url)
                    guard model.attachmentGeneration == generation else { return }
                    model.attachments.append(item)
                } catch { if !Task.isCancelled && model.attachmentGeneration == generation { model.error = error.localizedDescription } }
            }
            if !Task.isCancelled && model.attachmentGeneration == generation && urls.count > remaining { model.error = "Добавлены первые \(remaining) файлов: максимум 4 вложения" }
        }
    }
    private func importPhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty, !mediaLoading else { return }
        let generation = model.attachmentGeneration
        let remaining = max(0, 4 - model.attachments.count)
        guard remaining > 0 else { photos = []; model.error = "Можно прикрепить до 4 файлов"; return }
        let job = UUID(); activeMediaJob = job; mediaLoading = true
        preparationTask = Task {
            defer { if activeMediaJob == job { mediaLoading = false; photos = []; preparationTask = nil; activeMediaJob = nil } }
            for item in items.prefix(remaining) {
                if Task.isCancelled { return }
                do {
                    guard let selected = try await item.loadTransferable(type: PickedMedia.self) else { throw AgentError.message("Не удалось открыть выбранное медиа") }
                    defer { try? FileManager.default.removeItem(at: selected.url) }
                    let prepared = try await prepareFile(selected.url, name: item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) }) ? "Видео.mp4" : "Фото.jpg")
                    guard model.attachmentGeneration == generation else { return }
                    model.attachments.append(prepared)
                } catch { if !Task.isCancelled && model.attachmentGeneration == generation { model.error = error.localizedDescription } }
            }
        }
    }
    private var composer: some View {
        VStack(spacing: 10) {
            if let error = approvals.error {
                HStack { Text(error).font(.caption).foregroundStyle(.secondary); Button("Повторить") { Task { await approvals.refresh(server: server, conversation: model.conversationId) } } }.padding(.horizontal, 12)
            }
            if speech.isSpeaking {
                HStack { Text("Агент говорит").font(.caption); Spacer(); Button(speech.isPaused ? "Продолжить" : "Пауза") { speech.togglePause() }; Button("Стоп") { speech.stop() } }.font(.caption)
            }
            if let error = speech.error { Text(error).font(.caption).foregroundStyle(.secondary) }
            if let error = locator.error { Text(error).font(.caption).foregroundStyle(.secondary) }
            if mediaLoading || locator.loading || model.uploadStatus != nil { HStack { ProgressView(); Text(model.uploadStatus ?? (locator.loading ? "Определяем место…" : "Подготавливаем вложения…")).font(.caption) } }
            if !model.attachments.isEmpty {
                ScrollView(.horizontal) { HStack {
                    ForEach(model.attachments) { item in
                        HStack { Image(systemName: "paperclip"); Text(verbatim: item.name).lineLimit(1); Button { model.attachments.removeAll { $0.id == item.id } } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Удалить вложение") }
                            .font(.caption).padding(10).background(.thinMaterial, in: Capsule())
                    }
                } }
                Text("До 4 файлов по 10 МБ. Видео — до 2 минут. Файлы хранятся 30 дней; общий лимит — 40 МБ.").font(.caption2).foregroundStyle(.secondary)
            }
            if let place = model.location { HStack { locationLabel(place); Spacer(); Button("Убрать") { model.location = nil }.font(.caption) } }
            if let error = model.error { Text(error).font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 8) }
            if model.pending {
                HStack {
                    Button(model.busy ? "Запрос выполняется" : "Проверить ответ") { model.resume() }.disabled(model.busy)
                    Spacer()
                    if !model.busy { Button("Сбросить ожидание") { abandon = true } }
                }.font(.caption).padding(.horizontal, 8)
            }
            HStack(alignment: .bottom, spacing: 4) {
                Menu {
                    Button("Фото или видео", systemImage: "photo.on.rectangle") { voice.stop(); model.stopSpeech(); showPhotos = true }
                    if UIImagePickerController.isSourceTypeAvailable(.camera) { Button("Камера", systemImage: "camera") { voice.stop(); model.stopSpeech(); showCamera = true } }
                    Button("Файл", systemImage: "doc") { voice.stop(); model.stopSpeech(); showFiles = true }
                    Button("Геопозиция", systemImage: "location") {
                        let generation = model.attachmentGeneration
                        locator.request { place in if model.attachmentGeneration == generation { model.location = place } }
                    }
                    Divider()
                    Button("Быстрые действия", systemImage: "sparkle") { typing = false; actions = true }
                } label: { Image(systemName: "plus").font(.system(size: 22)).frame(width: 44, height: 46) }
                    .disabled(model.busy || model.pending || mediaLoading).accessibilityLabel("Прикрепить или выполнить действие")
                TextField(voice.recording ? "Слушаю…" : "Спросите Агента", text: $model.draft, axis: .vertical)
                    .font(.body).lineLimit(1...5).focused($typing).padding(.vertical, 12)
                Button { model.stopSpeech(); typing = false; if voice.recording || voice.starting { voice.finish() } else { startDictation() } } label: {
                    Image(systemName: (voice.recording || voice.starting) ? "stop.fill" : "mic").font(.system(size: 19)).frame(width: 44, height: 46)
                }.accessibilityLabel((voice.recording || voice.starting) ? "Остановить запись" : "Голосовой ввод")
                Button {
                    if model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.attachments.isEmpty && model.location == nil {
                        voice.stop(); model.stopSpeech(); typing = false; conversationVoice = true
                    } else { voice.stop(); typing = false; model.send(server: server) }
                } label: {
                    Image(systemName: model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.attachments.isEmpty && model.location == nil ? "waveform" : "arrow.up")
                        .font(.system(size: 18, weight: .semibold)).foregroundStyle(inverseInk).frame(width: 40, height: 40).background(ink, in: Circle()).frame(width: 44, height: 44)
                }.disabled(model.busy || model.pending || model.remoteBusy || mediaLoading || locator.loading).accessibilityLabel(model.draft.isEmpty ? "Начать голосовой разговор" : "Отправить").padding(.vertical, 3).padding(.trailing, 4)
            }.padding(6).modifier(AgentGlass(radius: 30))
            Text(voice.recording ? "Нажмите стоп, проверьте текст и отправьте" : voice.refining ? "Уточняю текст…" : "Агент помогает действовать. Важное проверяйте.")
                .font(.system(size: 11)).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }.padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 6)
    }
}
struct SettingsView: View {
    @Binding var server: String
    var connectionLocked = false
    @State private var serverDraft = ""
    @State private var code = ""
    @State private var status = ""
    @State private var pairing = false
    @State private var paired = false
    @State private var repairing = false
    /// Уже подключённый iPhone видит короткую сводку; форма кода — по «Подключить заново».
    private var connected: Bool { paired && !server.isEmpty }
    var body: some View {
        Form {
            if connected {
                Section {
                    LabeledContent {
                        Text(URL(string: server)?.host() ?? server).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    } label: {
                        Label("Подключено", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    }
                    DisclosureGroup("Подключить заново", isExpanded: $repairing) { pairingFields }
                    if !status.isEmpty { Text(status).font(.footnote) }
                } header: { Text("Сервер") }
            } else {
                Section {
                    pairingFields
                    if !status.isEmpty { Text(status).font(.footnote) }
                } header: { Text("Подключиться к лиду") } footer: {
                    Text("В личном чате с лидом отправьте /pair_native и вставьте код в течение 5 минут.")
                }
            }
            SigningKeySection(server: server)
            Section {
                NavigationLink { VoiceSettingsView() } label: { Label("Голос Агента", systemImage: "waveform") }
                NavigationLink { OpenFluxSettingsView(server: server) } label: { Label("OpenFlux · белые списки", systemImage: "network") }
            }
            if connected {
                Section {
                    Button("Отключить этот iPhone", role: .destructive) {
                        Credentials.delete(server: server); status = "Локальный ключ удалён"; refresh()
                    }.disabled(pairing || connectionLocked)
                } footer: {
                    Text("Отозвать все ключи сразу — /revoke_native в чате с лидом.")
                }
            }
        }
        .onAppear(perform: refresh)
        .onChange(of: server) { _, _ in refresh() }
        .navigationTitle("Подключение")
        .interactiveDismissDisabled(pairing)
    }
    @ViewBuilder private var pairingFields: some View {
        TextField("HTTPS-адрес, например https://agent.example.com", text: $serverDraft).disabled(pairing || connectionLocked).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
        SecureField("Одноразовый код", text: $code).disabled(pairing || connectionLocked).textInputAutocapitalization(.never).autocorrectionDisabled()
        Button(pairing ? "Подключаем…" : "Подключить iPhone") {
            pairing = true
            let pairingCode = code
            let target = serverDraft.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            Task {
                do { try await AgentAPI(server: target).pair(code: pairingCode); server = target; code = ""; status = "Устройство подключено"; repairing = false }
                catch { status = error.localizedDescription }
                pairing = false
                refresh()
            }
        }.disabled(pairing || connectionLocked || code.isEmpty)
    }
    private func refresh() {
        paired = !server.isEmpty && Credentials.read(server: server) != nil
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--connection-preview") { paired = !server.isEmpty }
        #endif
        if serverDraft.isEmpty { serverDraft = server }
    }
}

#if DEBUG
private struct PanelSheetPreview: View {
    @State private var open = true
    @State private var panel = true
    var body: some View {
        Color.clear.sheet(isPresented: $open) {
            NavigationStack {
                List { NavigationLink("Панель команды", isActive: $panel) { PanelView(server: "https://agent.invalid") } }
                    .navigationTitle("Агент")
            }.presentationDetents([.large]).presentationDragIndicator(.visible)
        }
    }
}
#endif
