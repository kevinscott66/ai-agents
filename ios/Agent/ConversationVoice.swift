import SwiftUI
import AVFoundation

/// Half-duplex: capture, transcription, agent work and playback never share the microphone.
@MainActor final class ConversationVoice: ObservableObject {
    @Published private(set) var phase: VoiceConversationPhase = .stopped
    @Published private(set) var level: Double = 0
    @Published private(set) var transcript = ""
    @Published private(set) var notice: String?
    var status: String { phase.status }
    var speaking: Bool { phase == .speaking }
    var failed: Bool { phase.failed }
    var canInterrupt: Bool { phase.canInterrupt }

    private var recorder: AVAudioRecorder?
    private var player: AVAudioPlayer?
    private var loop: Task<Void, Never>?
    private var speechRequest: Task<Data, Error>?
    private var generation = UUID()
    private var file: URL?
    private var conversationID: String?
    private var replies = VoiceReplyBuffer()
    private var ownsSession = false

    func receive(_ reply: ChatLine?) {
        guard loop != nil, let reply else { return }
        if !replies.append(id: reply.id, text: SpeechText.normalize(reply.text)) {
            notice = "Очередь озвучивания заполнена. Остальные ответы доступны в чате."
        }
    }
    func changedConversation(_ id: String?) {
        if id != conversationID { stop() }
    }
    func interrupt() {
        replies.interrupt()
        speechRequest?.cancel(); speechRequest = nil
        player?.stop(); player = nil; level = 0
        if canInterrupt { phase = .waiting }
    }
    func stop() {
        generation = UUID()
        loop?.cancel(); loop = nil
        interrupt()
        recorder?.stop(); recorder = nil
        if let file { try? FileManager.default.removeItem(at: file) }; file = nil
        let session = AVAudioSession.sharedInstance()
        // Do not deactivate audio if a different feature has already taken over the session.
        if ownsSession, session.category == .playAndRecord, session.mode == .voiceChat {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
        }
        ownsSession = false; phase = .stopped
    }
    private func check(_ id: UUID, model: ChatModel, server: String, token: String) throws {
        try Task.checkCancellation()
        guard id == generation else { throw CancellationError() }
        guard model.conversationId == conversationID else {
            throw AgentError.message("Диалог изменился. Начните голосовой разговор заново.")
        }
        guard Credentials.read(server: server) == token else {
            throw AgentError.message("Подключение изменилось. Закройте голосовой разговор.")
        }
    }
    private func busy(_ model: ChatModel) -> Bool { model.busy || model.pending || model.remoteBusy }

    func start(model: ChatModel, server: String) {
        stop(); phase = .connecting; transcript = ""; notice = nil
        conversationID = model.conversationId
        replies.reset(ignoring: model.newReplyForSpeech?.id)
        let id = generation
        loop = Task { [weak self] in
            guard let self else { return }
            do {
                guard let token = Credentials.read(server: server) else { throw AgentError.message("Подключите устройство в настройках") }
                let api = AgentAPI(server: server)
                guard try await api.voiceAvailable(expectedToken: token) else {
                    throw AgentError.message("Нейросетевой голос недоступен на сервере. Проверьте настройку голосового сервиса.")
                }
                try check(id, model: model, server: server, token: token)
                guard await AVAudioApplication.requestRecordPermission() else {
                    throw AgentError.message("Разрешите микрофон в настройках iPhone для голосового разговора.")
                }
                try check(id, model: model, server: server, token: token)
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
                try session.setActive(true); ownsSession = true
                while true {
                    try check(id, model: model, server: server, token: token)
                    if let text = replies.next() {
                        try await speak(text, api: api, id: id, model: model, server: server, token: token)
                        continue
                    }
                    if busy(model) {
                        if !model.busy && model.pending, let error = model.error { throw AgentError.message(error) }
                        phase = .waiting; level = 0
                        try await Task.sleep(for: .milliseconds(100)); continue
                    }
                    if let error = model.error { throw AgentError.message(error) }
                    guard model.draft.isEmpty, model.attachments.isEmpty, model.location == nil else {
                        throw AgentError.message("В чате есть незавершённый ввод. Отправьте или сохраните его перед разговором.")
                    }
                    guard let data = try await capture(id: id, model: model, server: server, token: token) else { continue }
                    phase = .transcribing
                    let text = try await api.transcribeVoice(data, expectedToken: token)
                    try check(id, model: model, server: server, token: token)
                    if text.isEmpty { continue }
                    transcript = text
                    guard model.draft.isEmpty, model.attachments.isEmpty, model.location == nil else {
                        throw AgentError.message("В чате изменился ввод. Распознанная фраза показана выше и не отправлена.")
                    }
                    model.draft = text
                    guard !busy(model) else {
                        throw AgentError.message("Агент уже выполняет запрос. Ваша фраза сохранена в черновике чата.")
                    }
                    guard model.send(server: server) else { throw AgentError.message(model.error ?? "Не удалось отправить сообщение") }
                    // A new dialog is allocated synchronously by send; it belongs to this session.
                    conversationID = model.conversationId
                }
            } catch is CancellationError { }
            catch {
                guard generation == id else { return }
                let message = error.localizedDescription
                stop(); phase = .failed(message)
            }
        }
    }

    private func speak(_ text: String, api: AgentAPI, id: UUID, model: ChatModel, server: String, token: String) async throws {
        let revision = replies.revision
        phase = .preparingSpeech
        let request = Task { try await api.speechAudio(text, voice: VoiceOutput.serverVoiceID, expectedToken: token) }
        speechRequest = request
        do {
            let audio = try await request.value
            try check(id, model: model, server: server, token: token)
            guard replies.revision == revision else { return }
            speechRequest = nil
            let output = try AVAudioPlayer(data: audio)
            output.isMeteringEnabled = true
            VoiceOutput.applyRate(output)
            guard output.prepareToPlay(), output.play() else { throw AgentError.message("Не удалось воспроизвести ответ") }
            player = output; phase = .speaking
            defer {
                output.stop()
                if player === output { player = nil; level = 0 }
            }
            while output.isPlaying {
                try check(id, model: model, server: server, token: token)
                guard replies.revision == revision else { return }
                output.updateMeters(); level = Self.amplitude(output.averagePower(forChannel: 0))
                try await Task.sleep(for: .milliseconds(50))
            }
        } catch {
            // Cancellation of this utterance is not cancellation of the conversation.
            guard generation == id, replies.revision == revision else { return }
            speechRequest = nil
            throw error
        }
    }

    private func capture(id: UUID, model: ChatModel, server: String, token: String) async throws -> Data? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".m4a")
        file = url
        defer {
            try? FileManager.default.removeItem(at: url)
            if file == url { file = nil }
        }
        let input = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 24000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64000])
        input.isMeteringEnabled = true
        guard input.record() else { throw AgentError.message("Не удалось включить микрофон") }
        recorder = input; phase = .listening
        defer {
            input.stop()
            if recorder === input { recorder = nil; level = 0 }
        }
        // Uptime is monotonic: changing wall time cannot extend recording indefinitely.
        let began = ProcessInfo.processInfo.systemUptime
        var lastSpeech: TimeInterval?; var voicedSamples = 0
        while true {
            try check(id, model: model, server: server, token: token)
            if VoiceConversationPolicy.yieldCapture(voicedSamples: voicedSamples, replyWaiting: !replies.isEmpty, agentBusy: busy(model)) { return nil }
            guard input.isRecording else { throw AgentError.message("Запись прервана. Начните разговор заново.") }
            input.updateMeters(); let power = input.averagePower(forChannel: 0)
            level = Self.amplitude(power)
            let now = ProcessInfo.processInfo.systemUptime
            if power > -38 { voicedSamples += 1; lastSpeech = now }
            if let lastSpeech, VoiceConversationPolicy.finishedUtterance(samples: voicedSamples, silence: now - lastSpeech) { break }
            if now - began >= 60 { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        input.stop()
        guard voicedSamples >= 4 else { return nil }
        return try Data(contentsOf: url)
    }
    private static func amplitude(_ decibels: Float) -> Double {
        min(1, max(0, pow(10, Double(decibels) / 20) * 3))
    }
}
struct ConversationVoiceView: View {
    @ObservedObject var model: ChatModel
    let server: String
    @StateObject private var voice = ConversationVoice()
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    var body: some View {
        NavigationStack {
            VStack(spacing: 28) {
                Spacer()
                Circle().fill(.primary.opacity(0.9))
                    .frame(width: 160, height: 160)
                    .scaleEffect(reducedMotion ? 1 : 1 + voice.level * 0.3)
                    .overlay { Circle().stroke(.primary.opacity(0.15), lineWidth: 12 + voice.level * 22) }
                    .accessibilityLabel(voice.speaking ? "Агент говорит" : "Голосовой разговор")
                Text(voice.status).font(.title3).multilineTextAlignment(.center)
                if !voice.transcript.isEmpty { Text(voice.transcript).textSelection(.enabled).foregroundStyle(.secondary).lineLimit(4).multilineTextAlignment(.center) }
                Spacer()
                if voice.canInterrupt { Button("Перебить ответ", systemImage: "stop.fill") { voice.interrupt() }.buttonStyle(.bordered).frame(minHeight: 44) }
                if let notice = voice.notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
                if voice.failed { Button("Попробовать снова") { voice.start(model: model, server: server) }.buttonStyle(.bordered) }
                Text("Голос создан ИИ. После паузы ваша фраза отправляется в этот чат автоматически.")
                    .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button("Завершить разговор", role: .cancel) { voice.stop(); dismiss() }.frame(minHeight: 44)
            }.padding(28).navigationTitle("Голосовой разговор").navigationBarTitleDisplayMode(.inline)
        }
        .task { voice.start(model: model, server: server) }
        .onChange(of: model.newReplyForSpeech?.id) { _, _ in voice.receive(model.newReplyForSpeech) }
        .onChange(of: model.conversationId) { _, id in voice.changedConversation(id) }
        .onChange(of: phase) { _, value in if value == .background { voice.stop(); dismiss() } }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { notification in
            guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            voice.stop(); dismiss()
        }
        .onDisappear { voice.stop() }
    }
}
