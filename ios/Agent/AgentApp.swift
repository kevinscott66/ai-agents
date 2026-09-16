import SwiftUI
import AVFoundation

struct ChatLine: Identifiable, Codable { var id = UUID().uuidString; let role: String; let text: String }
@MainActor final class ChatModel: ObservableObject {
    @Published var lines: [ChatLine] = []
    @Published var busy = false
    @Published var pending = UserDefaults.standard.string(forKey: "pendingTurn") != nil
    @Published var error: String?
    @Published var draft = ""
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
            syncGeneration = UUID(); boundServer = server; boundToken = token
            conversationCursor = nil; moreConversations = false; loadedMoreConversations = false
            lines = []; conversations = []; fresh = false; firstSequence = nil; moreHistory = false; remoteBusy = false
            conversationId = UserDefaults.standard.string(forKey: "conversation:" + server)
        }
    }
    func newConversation(server: String) {
        guard !busy, !pending else { return }
        bind(server: server)
        syncGeneration = UUID(); conversationId = nil; lines = []; draft = ""; fresh = true; moreHistory = false; firstSequence = nil
        UserDefaults.standard.removeObject(forKey: "conversation:" + server)
    }
    func selectConversation(_ id: String, server: String) async {
        guard !busy, !pending else { return }
        bind(server: server)
        syncGeneration = UUID(); conversationId = id; fresh = false; lines = []; draft = ""; firstSequence = nil; moreHistory = false
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
                let incoming = history.messages.map { ChatLine(id:$0.id,role:$0.role == "user" ? "Вы" : "Агент",text:$0.text) }
                if older {
                    let ids = Set(lines.map(\.id)); lines = incoming.filter { !ids.contains($0.id) } + lines
                    firstSequence = history.messages.first?.seq ?? firstSequence; moreHistory = history.more
                } else {
                    // Retain already loaded older pages while replacing the current server window.
                    let first = incoming.first.flatMap { item in lines.firstIndex(where: { $0.id == item.id }) }
                    lines = (first.map { Array(lines.prefix($0)) } ?? []) + incoming
                    if firstSequence == nil || first == nil { firstSequence = history.messages.first?.seq; moreHistory = history.more }
                }
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
    private let speaker = ReplySpeaker()
    private var polling: Task<Void, Never>?
    private var currentReplies = 0
    private var currentTurn: String?
    private var operation = UUID()
    @discardableResult func send(server: String) -> Bool {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !busy, !remoteBusy else { return false }
        guard text.utf16.count <= 8_000 else { error = "Сообщение слишком длинное. Сократите его до 8000 символов."; return false }
        guard !pending else { error = "Сначала проверьте ответ на предыдущий запрос."; return false }
        bind(server: server)
        guard let token = boundToken else { error = "Подключите устройство в настройках"; return false }
        let dialogID = conversationId ?? UUID().uuidString
        conversationId = dialogID; fresh = false; syncGeneration = UUID()
        UserDefaults.standard.set(dialogID, forKey: "conversation:" + server)
        let id = UUID().uuidString
        draft = ""; error = nil; busy = true; pending = true; currentReplies = 0; currentTurn = id
        lines.append(ChatLine(id: id + ":user", role: "Вы", text: text))
        // Save the request ID before sending. A reconnect only polls this ID.
        UserDefaults.standard.set(id, forKey: "pendingTurn")
        UserDefaults.standard.set(server, forKey: "pendingServer")
        UserDefaults.standard.set(dialogID, forKey: "pendingConversation")
        let activeOperation = UUID()
        operation = activeOperation
        polling = Task {
            var submitted = false
            do {
                try await AgentAPI(server: server).createConversation(dialogID, title: text, expectedToken: token)
                try Task.checkCancellation()
                submitted = true
                let first = try await AgentAPI(server: server).send(text, id: id, conversationId: dialogID, expectedToken: token)
                try Task.checkCancellation()
                guard boundServer == server, boundToken == token, Credentials.read(server: server) == token else { throw AgentError.message("Подключение изменилось") }
                consume(first)
                if first.status == "running" { try await watch(server: server, id: id, token: token) }
            } catch is CancellationError { } catch {
                guard operation == activeOperation, !Task.isCancelled else { return }
                if !submitted || error is TurnRejected { submitted = false; clearPending(); draft = text; lines.removeAll { $0.id == id + ":user" } }
                self.error = error.localizedDescription + (submitted ? " Если запрос принят сервером, нажмите «Проверить ответ»." : ""); busy = false }
        }
        return true
    }
    func resume() {
        guard !busy, let pendingServer = UserDefaults.standard.string(forKey: "pendingServer"),
              let id = UserDefaults.standard.string(forKey: "pendingTurn") else { return }
        bind(server: pendingServer)
        guard let token = boundToken else { error = "Подключите устройство в настройках"; return }
        conversationId = UserDefaults.standard.string(forKey:"pendingConversation")
        boundServer = pendingServer
        if currentTurn != id { currentReplies = 0; currentTurn = id }
        error = nil; busy = true
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
        for (index, text) in turn.replies.enumerated().dropFirst(currentReplies) { lines.append(ChatLine(id: turn.id + ":reply:" + String(index + 1), role: "Агент", text: text)) }
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
    func speak(_ text: String, server: String) {
        guard let token = Credentials.read(server: server) else { error = "Подключите устройство в настройках"; return }
        speaker.speak(text, server: server, token: token) { [weak self] message in self?.error = "Озвучка: " + message }
    }
    func stopSpeech() { speaker.stop() }
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
        if ProcessInfo.processInfo.arguments.contains("--approval-preview") { ChatApprovalPreview() }
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
    @StateObject private var approvals = ChatApprovals()
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
                if scenePhase == .active { await approvals.refresh(server: server, conversation: model.conversationId); await model.synchronize(server: server) }
                do { try await Task.sleep(for: .seconds(5)) } catch { break }
            }
        }
        .onChange(of: server) { _, _ in voice.stop(); model.stopSpeech() }
        .onChange(of: menu) { _, opened in if opened { voice.stop(); model.stopSpeech() } }
        .onChange(of: actions) { _, opened in if opened { voice.stop(); model.stopSpeech() } }
        .onChange(of: settings) { _, opened in if opened { voice.stop(); model.stopSpeech() } }
        .onChange(of: model.conversationId) { _, conversation in
            voice.stop(); model.stopSpeech()
            Task { await approvals.refresh(server: server, conversation: conversation) }
        }
        .onChange(of: model.busy) { _, busy in
            if !busy && scenePhase == .active { Task { await approvals.refresh(server: server, conversation: model.conversationId) } }
        }
        .onChange(of: voice.text) { _, value in model.draft = value }
        .onChange(of: voice.error) { _, value in if let value { model.error = value } }
        .onAppear { if server.isEmpty { settings = true } }
        .onDisappear { voice.stop(); model.stopSpeech() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { voice.stop(); model.stopSpeech() }
        }
        .sheet(isPresented: $menu) {
            NavigationStack {
                List {
                    Section {
                        Label("Чат с лидом", systemImage: "bubble.left.and.bubble.right")
                        NavigationLink { PanelView(server: server, onMacStart: { project, task, provider in
                            guard !model.busy && !model.pending && !model.remoteBusy else { throw AgentError.message("Дождитесь завершения текущего запроса") }
                            model.draft = "Запусти рабочую сессию на моём Mac через MAC_RUN_CLAUDE. Исполнитель: \(provider). Передай provider=\(provider) в MAC_RUN_CLAUDE; не заменяй исполнителя. Проект: \(project). Задача: \(task)"
                            guard model.send(server: server) else { throw AgentError.message(model.error ?? "Не удалось отправить запрос") }
                        }) } label: { Label("Панель команды", systemImage: "rectangle.grid.2x2") }
                        NavigationLink { ActionsView { choose($0); menu = false } } label: { Label("Все действия", systemImage: "square.grid.2x2") }
                        NavigationLink { SettingsView(server: $server).disabled(model.busy || model.pending) } label: { Label("Подключение", systemImage: "slider.horizontal.3") }
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
                        }
                        if model.moreConversations { Button("Предыдущие диалоги") { Task { await model.loadMoreConversations(server: server) } } }
                        Button("Обновить историю") { Task { await model.synchronize(server: server) } }
                    }
                    Section("Быстрый старт") {
                        Button { choose("Агент, начни мой день"); menu = false } label: { Label("Начать день", systemImage: "sun.max") }
                        Button { choose("Агент, покажи календарь"); menu = false } label: { Label("Календарь", systemImage: "calendar") }
                        Button { choose("Агент, подведи итоги дня"); menu = false } label: { Label("Итоги дня", systemImage: "moon") }
                    }
                    Section { Text("Один собеседник. Команда из 12 ролей.").font(.footnote).foregroundStyle(.secondary) }
                }.navigationTitle("Агент").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { menu = false } } }
            }.presentationDetents([.large]).presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $actions) {
            NavigationStack { ActionsView { choose($0); actions = false }.toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { actions = false } } } }
                .presentationDetents([.large]).presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $settings) {
            NavigationStack { SettingsView(server: $server).disabled(model.busy || model.pending).toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { settings = false } } } }
                .presentationDragIndicator(.visible)
        }
        .alert("Сбросить ожидание?", isPresented: $abandon) {
            Button("Продолжить ждать", role: .cancel) {}
            Button("Сбросить", role: .destructive) { model.abandonWaiting() }
        } message: { Text("Это не остановит работу на сервере. Повтор команды может выполнить действие ещё раз.") }
    }
    private func choose(_ text: String) { voice.stop(); model.draft = text; typing = true }
    private var chat: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if model.remoteBusy && !model.busy { Text("Агент выполняет запрос с другого устройства. Ответ появится в соответствующем диалоге.").font(.footnote).foregroundStyle(.secondary).padding() }
                if model.lines.isEmpty && approvals.items.isEmpty {
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
                            if let item = approvals.items.first(where: { line.id == "approval:" + $0.id + ":result" }) {
                                approvalCard(item)
                            }
                            if line.role == "Вы" {
                                HStack { Spacer(minLength: 44); Text(line.text).font(.body).textSelection(.enabled).padding(.horizontal, 18).padding(.vertical, 12).background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 24)) }.id(line.id)
                            } else {
                                VStack(alignment: .leading, spacing: 12) {
                                    Text(.init(line.text)).font(.body).lineSpacing(5).textSelection(.enabled)
                                    HStack(spacing: 8) {
                                        Button { UIPasteboard.general.string = line.text } label: { Image(systemName: "doc.on.doc").frame(width: 44, height: 44) }.accessibilityLabel("Скопировать ответ")
                                        Button { voice.stop(); model.speak(line.text, server: server) } label: { Image(systemName: "speaker.wave.2").frame(width: 44, height: 44) }.accessibilityLabel("Озвучить ответ")
                                        Button { model.stopSpeech() } label: { Image(systemName: "speaker.slash").frame(width: 44, height: 44) }.accessibilityLabel("Остановить озвучивание")
                                    }.font(.system(size: 15)).foregroundStyle(.secondary)
                                }.id(line.id)
                            }
                        }
                        ForEach(approvals.items.filter { item in !model.lines.contains(where: { $0.id == "approval:" + item.id + ":result" }) }) { item in
                            approvalCard(item)
                        }
                        if model.busy { HStack(spacing: 10) { ProgressView(); Text("Агент работает").font(.subheadline).foregroundStyle(.secondary) } }
                    }.padding(.horizontal, 22).padding(.vertical, 24)
                }
            }.scrollDismissesKeyboard(.interactively)
                .onChange(of: approvals.items.count) { _, _ in
                    if let item = approvals.items.last { proxy.scrollTo("approval-" + item.id, anchor: .bottom) }
                }
                .onChange(of: model.lines.last?.id) { _, _ in
                    if let id = model.lines.last?.id {
                        if reducedMotion { proxy.scrollTo(id, anchor: .bottom) }
                        else { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(id, anchor: .bottom) } }
                    }
                }
        }
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
    private var composer: some View {
        VStack(spacing: 10) {
            if let error = approvals.error {
                HStack { Text(error).font(.caption).foregroundStyle(.secondary); Button("Повторить") { Task { await approvals.refresh(server: server, conversation: model.conversationId) } } }.padding(.horizontal, 12)
            }
            if let error = model.error { Text(error).font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 8) }
            if model.pending {
                HStack {
                    Button(model.busy ? "Запрос выполняется" : "Проверить ответ") { model.resume() }.disabled(model.busy)
                    Spacer()
                    if !model.busy { Button("Сбросить ожидание") { abandon = true } }
                }.font(.caption).padding(.horizontal, 8)
            }
            HStack(alignment: .bottom, spacing: 4) {
                Button { typing = false; actions = true } label: { Image(systemName: "plus").font(.system(size: 22, weight: .regular)).frame(width: 44, height: 46) }.accessibilityLabel("Быстрые действия")
                TextField(voice.recording ? "Слушаю…" : "Спросите Агента", text: $model.draft, axis: .vertical)
                    .font(.body).lineLimit(1...5).focused($typing).padding(.vertical, 12)
                Button { model.stopSpeech(); typing = false; if voice.recording || voice.starting { voice.stop() } else { Task { await voice.start() } } } label: {
                    Image(systemName: (voice.recording || voice.starting) ? "stop.fill" : "mic").font(.system(size: 19)).frame(width: 44, height: 46)
                }.accessibilityLabel((voice.recording || voice.starting) ? "Остановить запись" : "Голосовой ввод")
                Button {
                    if model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        model.stopSpeech(); typing = false; Task { await voice.start() }
                    } else { voice.stop(); typing = false; model.send(server: server) }
                } label: {
                    Image(systemName: model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "waveform" : "arrow.up")
                        .font(.system(size: 18, weight: .semibold)).foregroundStyle(inverseInk).frame(width: 40, height: 40).background(ink, in: Circle()).frame(width: 44, height: 44)
                }.disabled(model.busy || model.pending || model.remoteBusy).accessibilityLabel(model.draft.isEmpty ? "Начать голосовой ввод" : "Отправить").padding(.vertical, 3).padding(.trailing, 4)
            }.padding(6).modifier(AgentGlass(radius: 30))
            Text(voice.recording ? "Нажмите стоп, проверьте текст и отправьте" : "Агент помогает действовать. Важное проверяйте.")
                .font(.system(size: 11)).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }.padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 6)
    }
}
struct SettingsView: View {
    @Binding var server: String
    @State private var serverDraft = ""
    @State private var code = ""
    @State private var status = ""
    @State private var pairing = false
    var body: some View {
        Form {
            Section("Подключиться к лиду") {
                TextField("HTTPS-адрес, например https://agent.example.com", text: $serverDraft).disabled(pairing).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                SecureField("Одноразовый код", text: $code).disabled(pairing).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button(pairing ? "Подключаем…" : "Подключить iPhone") {
                    pairing = true
                    let pairingCode = code
                    let target = serverDraft.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                    Task {
                        do { try await AgentAPI(server: target).pair(code: pairingCode); server = target; code = ""; status = "Устройство подключено" }
                        catch { status = error.localizedDescription }
                        pairing = false
                    }
                }.disabled(pairing || code.isEmpty || !serverDraft.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("https://"))
                Text(status).font(.footnote)
            }
            Section("Как получить код") {
                Text("В личном чате с лидом отправьте /pair_native. Вставьте полученный код сюда в течение 5 минут.")
                Text("Доступ к GitHub, серверам и другим сервисам выполняется лидом через настроенные инструменты сервера и Mac.").foregroundStyle(.secondary)
            }
            Section("Управление доступом") {
                Button("Удалить ключ с этого iPhone", role: .destructive) { Credentials.delete(server: server); status = "Локальный ключ удалён" }.disabled(pairing)
                Text("Для отзыва всех ключей отправьте лиду /revoke_native. Подтверждения действий доступны в существующей Telegram-панели.").font(.footnote)
            }
        }.navigationTitle("Подключение")
            .onAppear { serverDraft = server }
            .interactiveDismissDisabled(pairing)
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
