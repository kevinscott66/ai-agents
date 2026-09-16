import SwiftUI
import AVFoundation

/// Half-duplex conversation: the microphone is closed during transcription, model work and speech.
@MainActor final class ConversationVoice: ObservableObject {
    @Published private(set) var status = "Подключаю голос…"
    @Published private(set) var level: Double = 0
    @Published private(set) var speaking = false
    @Published private(set) var failed = false
    @Published private(set) var transcript = ""
    private var recorder: AVAudioRecorder?
    private var player: AVAudioPlayer?
    private var loop: Task<Void, Never>?
    private var generation = UUID()
    private var file: URL?
    private var conversationID: String?
    private var seen = Set<String>()
    private var replies: [String] = []
    private var ownsSession = false

    func receive(_ reply: ChatLine?) {
        guard loop != nil, let reply, seen.insert(reply.id).inserted else { return }
        let text = SpeechText.normalize(reply.text)
        if !text.isEmpty { replies.append(contentsOf: VoiceConversationPolicy.chunks(text)) }
    }
    func changedConversation(_ id: String?) {
        if id != conversationID { stop() }
    }
    func interrupt() {
        // Existing queued replies are deliberately skipped; later new replies remain eligible.
        player?.stop(); player = nil; replies.removeAll(); speaking = false; level = 0
    }
    func stop() {
        generation = UUID(); loop?.cancel(); loop = nil
        recorder?.stop(); recorder = nil; player?.stop(); player = nil
        if let file { try? FileManager.default.removeItem(at: file) }; file = nil
        replies.removeAll(); speaking = false; level = 0
        if ownsSession { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        ownsSession = false; status = "Разговор остановлен"
    }
    private func check(_ id: UUID, server: String, token: String) throws {
        try Task.checkCancellation()
        guard id == generation else { throw CancellationError() }
        guard Credentials.read(server: server) == token else { throw AgentError.message("Подключение изменилось. Закройте голосовой разговор.") }
    }
    func start(model: ChatModel, server: String) {
        stop(); failed = false; status = "Подключаю голос…"; transcript = ""
        conversationID = model.conversationId
        seen = Set(model.newReplyForSpeech.map { [$0.id] } ?? [])
        let id = generation
        loop = Task { [weak self] in
            guard let self else { return }
            do {
                guard let token = Credentials.read(server: server) else { throw AgentError.message("Подключите устройство в настройках") }
                let api = AgentAPI(server: server)
                guard try await api.voiceAvailable(expectedToken: token) else { throw AgentError.message("Нейросетевой голос недоступен на сервере. Проверьте настройку голосового сервиса.") }
                try check(id, server: server, token: token)
                guard await AVAudioApplication.requestRecordPermission() else { throw AgentError.message("Разрешите микрофон в настройках iPhone для голосового разговора.") }
                try check(id, server: server, token: token)
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
                try session.setActive(true); ownsSession = true
                while true {
                    try check(id, server: server, token: token)
                    if !replies.isEmpty {
                        status = "Готовлю голос…"
                        let text = replies.removeFirst()
                        let audio = try await api.speechAudio(text, expectedToken: token)
                        try check(id, server: server, token: token)
                        let output = try AVAudioPlayer(data: audio)
                        output.isMeteringEnabled = true
                        guard output.prepareToPlay(), output.play() else { throw AgentError.message("Не удалось воспроизвести ответ") }
                        player = output; speaking = true; status = "Агент говорит"
                        while output.isPlaying {
                            try check(id, server: server, token: token)
                            output.updateMeters(); level = Self.amplitude(output.averagePower(forChannel: 0))
                            try await Task.sleep(for: .milliseconds(50))
                        }
                        player = nil; speaking = false; level = 0
                        continue
                    }
                    if model.busy || model.pending || model.remoteBusy {
                        if !model.busy && model.pending, let error = model.error { throw AgentError.message(error) }
                        status = "Агент думает…"; level = 0
                        try await Task.sleep(for: .milliseconds(100)); continue
                    }
                    if let error = model.error { throw AgentError.message(error) }
                    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".m4a")
                    file = url
                    let input = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 24000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64000])
                    input.isMeteringEnabled = true
                    guard input.record() else { throw AgentError.message("Не удалось включить микрофон") }
                    recorder = input; status = "Слушаю вас"
                    let began = Date(); var lastSpeech: Date?; var voicedSamples = 0
                    while true {
                        try check(id, server: server, token: token)
                        guard input.isRecording else { throw AgentError.message("Запись прервана. Начните разговор заново.") }
                        input.updateMeters(); let power = input.averagePower(forChannel: 0)
                        level = Self.amplitude(power)
                        if power > -38 { voicedSamples += 1; lastSpeech = Date() }
                        if let lastSpeech, VoiceConversationPolicy.finishedUtterance(samples: voicedSamples, silence: Date().timeIntervalSince(lastSpeech)) { break }
                        if Date().timeIntervalSince(began) >= 60 { break }
                        try await Task.sleep(for: .milliseconds(50))
                    }
                    input.stop(); recorder = nil; level = 0
                    let data = try Data(contentsOf: url)
                    try? FileManager.default.removeItem(at: url); file = nil
                    if voicedSamples < 4 { continue }
                    status = "Распознаю речь…"
                    let text = try await api.transcribeVoice(data, expectedToken: token)
                    try check(id, server: server, token: token)
                    if text.isEmpty { continue }
                    transcript = text
                    guard !model.busy, !model.pending, !model.remoteBusy, model.draft.isEmpty,
                          model.attachments.isEmpty, model.location == nil else { throw AgentError.message("В чате есть незавершённый ввод или запрос. Завершите его перед разговором.") }
                    model.draft = text
                    guard model.send(server: server) else { throw AgentError.message(model.error ?? "Не удалось отправить сообщение") }
                    // send synchronously allocates a new dialog; that is still this voice session.
                    conversationID = model.conversationId
                }
            } catch is CancellationError { }
            catch {
                guard generation == id else { return }
                let message = error.localizedDescription
                stop(); failed = true; status = message
            }
        }
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
                if !voice.transcript.isEmpty { Text(voice.transcript).foregroundStyle(.secondary).lineLimit(4).multilineTextAlignment(.center) }
                Spacer()
                if voice.speaking { Button("Перебить ответ", systemImage: "stop.fill") { voice.interrupt() }.buttonStyle(.bordered).frame(minHeight: 44) }
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
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in voice.stop(); dismiss() }
        .onDisappear { voice.stop() }
    }
}

/// Pure boundaries shared by the live recorder and deterministic fixtures.
enum VoiceConversationPolicy {
    static func finishedUtterance(samples: Int, silence: TimeInterval) -> Bool {
        samples >= 4 && silence >= 1.2
    }
    static func chunks(_ text: String) -> [String] {
        var result: [String] = []; var chunk = ""; var units = 0
        for character in text {
            let size = String(character).utf16.count
            if units + size > 3000 && !chunk.isEmpty { result.append(chunk); chunk = ""; units = 0 }
            // A pathological single grapheme must still respect the server's UTF16 limit.
            if size > 3000 { continue }
            chunk.append(character); units += size
        }
        if !chunk.isEmpty { result.append(chunk) }
        return result
    }
}
