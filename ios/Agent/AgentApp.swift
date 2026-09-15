import SwiftUI
import AVFoundation

struct ChatLine: Identifiable, Codable { var id = UUID(); let role: String; let text: String }
@MainActor final class ChatModel: ObservableObject {
    @Published var lines: [ChatLine] = []
    @Published var busy = false
    @Published var pending = UserDefaults.standard.string(forKey: "pendingTurn") != nil
    @Published var error: String?
    @Published var draft = ""
    private let speaker = AVSpeechSynthesizer()
    private var polling: Task<Void, Never>?
    private var currentReplies = 0
    private var currentTurn: String?
    private var operation = UUID()
    func send(server: String) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !busy else { return }
        guard !pending else { error = "Сначала проверьте ответ на предыдущий запрос."; return }
        let id = UUID().uuidString
        draft = ""; error = nil; busy = true; pending = true; currentReplies = 0; currentTurn = id
        lines.append(ChatLine(role: "Вы", text: text))
        // Save the request ID before sending. A reconnect only polls this ID.
        UserDefaults.standard.set(id, forKey: "pendingTurn")
        UserDefaults.standard.set(server, forKey: "pendingServer")
        let activeOperation = UUID()
        operation = activeOperation
        polling = Task {
            do {
                let first = try await AgentAPI(server: server).send(text, id: id)
                try Task.checkCancellation()
                consume(first)
                if first.status == "running" { try await watch(server: server, id: id) }
            } catch is CancellationError { } catch {
                guard operation == activeOperation, !Task.isCancelled else { return }
                self.error = error.localizedDescription + " Если запрос принят сервером, нажмите «Проверить ответ»."; busy = false }
        }
    }
    func resume() {
        guard !busy, let pendingServer = UserDefaults.standard.string(forKey: "pendingServer"),
              let id = UserDefaults.standard.string(forKey: "pendingTurn") else { return }
        if currentTurn != id { currentReplies = 0; currentTurn = id }
        error = nil; busy = true
        let activeOperation = UUID()
        operation = activeOperation
        polling = Task {
            do { try await watch(server: pendingServer, id: id) }
            catch is CancellationError { }
            catch {
                guard operation == activeOperation, !Task.isCancelled else { return }
                self.error = error.localizedDescription; busy = false
            }
        }
    }
    private func watch(server: String, id: String) async throws {
        for _ in 0..<300 {
            try Task.checkCancellation()
            let result = try await AgentAPI(server: server).poll(id)
            try Task.checkCancellation()
            consume(result)
            if result.status != "running" { return }
            try await Task.sleep(for: .seconds(2))
        }
        busy = false
        error = "Запрос ещё выполняется. Нажмите «Проверить ответ» позже."
    }
    private func consume(_ turn: Turn) {
        for text in turn.replies.dropFirst(currentReplies) { lines.append(ChatLine(role: "Агент", text: text)) }
        currentReplies = turn.replies.count
        if turn.status != "running" {
            busy = false; pending = false
            UserDefaults.standard.removeObject(forKey: "pendingTurn")
            UserDefaults.standard.removeObject(forKey: "pendingServer")
            if turn.status == "interrupted" { error = "Сервер перезапущен. Задача могла выполнить часть действий — уточните её состояние." }
        }
    }
    func abandonWaiting() {
        operation = UUID()
        polling?.cancel(); polling = nil; busy = false; pending = false
        UserDefaults.standard.removeObject(forKey: "pendingTurn")
        UserDefaults.standard.removeObject(forKey: "pendingServer")
        error = "Ожидание сброшено. Серверная задача могла продолжить работу; перед повтором проверьте её состояние."
    }
    func speak(_ text: String) {
        speaker.stopSpeaking(at: .immediate)
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "ru-RU")
        speaker.speak(utterance)
    }
    func stopSpeech() { speaker.stopSpeaking(at: .immediate) }
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
    @AppStorage("server") private var server = "https://agents.dobropalm.tech:8443"
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
                        Button { typing = true } label: { Image(systemName: "square.and.pencil").font(.system(size: 20, weight: .regular)) }.accessibilityLabel("Написать сообщение")
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) { composer }
                .background(canvas)
        }
        .task(id: server) {
            while !Task.isCancelled {
                if scenePhase == .active { await approvals.refresh(server: server) }
                do { try await Task.sleep(for: .seconds(5)) } catch { break }
            }
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
                        Label("Чат с лидом", systemImage: "bubble.left.and.bubble.right")
                        NavigationLink { PanelView(server: server) } label: { Label("Панель команды", systemImage: "rectangle.grid.2x2") }
                        NavigationLink { ActionsView { choose($0); menu = false } } label: { Label("Все действия", systemImage: "square.grid.2x2") }
                        NavigationLink { SettingsView(server: $server) } label: { Label("Подключение", systemImage: "slider.horizontal.3") }
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
            NavigationStack { SettingsView(server: $server).toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { settings = false } } } }
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
                        ForEach(model.lines) { line in
                            if line.role == "Вы" {
                                HStack { Spacer(minLength: 44); Text(line.text).font(.body).textSelection(.enabled).padding(.horizontal, 18).padding(.vertical, 12).background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 24)) }.id(line.id)
                            } else {
                                VStack(alignment: .leading, spacing: 12) {
                                    Text(.init(line.text)).font(.body).lineSpacing(5).textSelection(.enabled)
                                    HStack(spacing: 8) {
                                        Button { UIPasteboard.general.string = line.text } label: { Image(systemName: "doc.on.doc").frame(width: 44, height: 44) }.accessibilityLabel("Скопировать ответ")
                                        Button { voice.stop(); model.speak(line.text) } label: { Image(systemName: "speaker.wave.2").frame(width: 44, height: 44) }.accessibilityLabel("Озвучить ответ")
                                        Button { model.stopSpeech() } label: { Image(systemName: "speaker.slash").frame(width: 44, height: 44) }.accessibilityLabel("Остановить озвучивание")
                                    }.font(.system(size: 15)).foregroundStyle(.secondary)
                                }.id(line.id)
                            }
                        }
                        ForEach(approvals.items) { item in
                            ChatApprovalCard(item: item, outcome: approvals.outcomes[item.id], working: approvals.working.contains(item.id)) { approve in
                                Task { await approvals.decide(item, approve: approve, server: server) }
                            }.id("approval-" + item.id)
                        }
                        if model.busy { HStack(spacing: 10) { ProgressView(); Text("Агент работает").font(.subheadline).foregroundStyle(.secondary) } }
                    }.padding(.horizontal, 22).padding(.vertical, 24)
                }
            }.scrollDismissesKeyboard(.interactively)
                .onChange(of: approvals.items.count) { _, _ in
                    if let item = approvals.items.last { proxy.scrollTo("approval-" + item.id, anchor: .bottom) }
                }
                .onChange(of: model.lines.count) { _, _ in
                    if let id = model.lines.last?.id {
                        if reducedMotion { proxy.scrollTo(id, anchor: .bottom) }
                        else { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(id, anchor: .bottom) } }
                    }
                }
        }
    }
    private func suggestion(_ title: String, icon: String, prompt: String) -> some View {
        Button { choose(prompt) } label: { Label(title, systemImage: icon).font(.subheadline).padding(.horizontal, 16).padding(.vertical, 12) }
            .buttonStyle(.plain).overlay(Capsule().stroke(ink.opacity(0.10), lineWidth: 0.7))
    }
    private var composer: some View {
        VStack(spacing: 10) {
            if let error = approvals.error { Text(error).font(.caption).foregroundStyle(.secondary) }
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
                }.disabled(model.busy || model.pending).accessibilityLabel(model.draft.isEmpty ? "Начать голосовой ввод" : "Отправить").padding(.vertical, 3).padding(.trailing, 4)
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
                TextField("HTTPS-адрес сервера", text: $serverDraft).disabled(pairing).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
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
                }.disabled(pairing || code.isEmpty)
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
