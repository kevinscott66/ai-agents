import Foundation

/// Pure preparation for spoken replies. The text itself is only cleaned here.
enum SpeechText {
    static func normalize(_ source: String) -> String {
        var text = String(source.prefix(24_000)).replacingOccurrences(of: "\r\n", with: "\n")
        func replace(_ pattern: String, _ replacement: String) {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { return }
            text = regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: replacement)
        }
        replace("(?s)```.*?(?:```|$)|~~~.*?(?:~~~|$)", " ")
        replace("!\\[[^\\]]*\\]\\([^)]*\\)", " ")
        replace("\\[([^\\]]+)\\]\\([^)]*\\)", "$1")
        replace("(?i)\\b[a-z][a-z0-9+.-]*://[^\\s<>]+|\\bwww\\.[^\\s<>]+", " ")
        replace("<[^>]+>", " ")
        replace("(?m)^[ \\t]{0,3}(?:#{1,6}[ \\t]+|>[ \\t]*|[-+*][ \\t]+|[0-9]+[.)][ \\t]+)", "")
        replace("(?m)^[ \\t]*[-*_]{3,}[ \\t]*$", " ")
        replace("[*_~`]+", "")
        replace("\\|", ", ")
        replace("[\\t ]+", " ")
        replace(" +([.,!?;:])", "$1")
        replace(" *\\n *", "\n")
        replace("\\n{3,}", "\n\n")
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

import AVFoundation
import SwiftUI

@MainActor final class VoiceOutput: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    static let shared = VoiceOutput()
    static let automaticPreference = "voiceAutomaticallySpeak"
    static var autoSpeak: Bool { UserDefaults.standard.bool(forKey: automaticPreference) }
    private static let identifierPreference = "voiceOutputIdentifier"
    private static let ratePreference = "voiceOutputRate"
    static let sourcePreference = "voiceOutputSource"
    static let serverVoicePreference = "voiceServerVoice"
    static let defaultServerVoice = "marin"
    /// Живой голос сервера — основной; голос устройства выбирают вручную или он подхватывает без связи.
    static var usesServerVoice: Bool { UserDefaults.standard.string(forKey: sourcePreference) != "device" }
    static var serverVoiceID: String { UserDefaults.standard.string(forKey: serverVoicePreference) ?? defaultServerVoice }
    /// Темп из настроек и для серверного голоса: обычный темп устройства = 1×.
    static func applyRate(_ player: AVAudioPlayer) {
        let saved = UserDefaults.standard.object(forKey: ratePreference) as? NSNumber
        let rate = clampedRate(saved?.floatValue ?? AVSpeechUtteranceDefaultSpeechRate)
        player.enableRate = true
        player.rate = rate / AVSpeechUtteranceDefaultSpeechRate
    }
    static let rateRange: ClosedRange<Float> = 0.35...0.65

    @Published private(set) var isSpeaking = false
    @Published private(set) var isPaused = false
    @Published private(set) var error: String?
    @Published private(set) var availableVoices: [AVSpeechSynthesisVoice] = []
    @Published private(set) var rate: Float
    @Published private(set) var serverVoices = [ServerVoice(id: VoiceOutput.defaultServerVoice, label: "Марин", note: "живой, тёплый — по умолчанию")]
    @Published var serverVoice: String {
        didSet { UserDefaults.standard.set(serverVoice, forKey: Self.serverVoicePreference) }
    }
    @Published var useServerVoice: Bool {
        didSet { UserDefaults.standard.set(useServerVoice ? "server" : "device", forKey: Self.sourcePreference) }
    }
    @Published var voiceIdentifier: String {
        didSet { UserDefaults.standard.set(voiceIdentifier, forKey: Self.identifierPreference) }
    }
    private let synthesizer = AVSpeechSynthesizer()
    private var utteranceID: ObjectIdentifier?
    private var queuedTexts: [String] = []
    private var ownsPlayback = false
    private var interruptionObserver: NSObjectProtocol?
    /// Paired server whose neural voice is shared with voice conversations; the device voice is the fallback.
    var server: String?
    private var serverTask: Task<Void, Never>?
    private var player: AVAudioPlayer?
    private var playback = UUID()

    private override init() {
        voiceIdentifier = UserDefaults.standard.string(forKey: Self.identifierPreference) ?? ""
        serverVoice = Self.serverVoiceID
        useServerVoice = Self.usesServerVoice
        let saved = UserDefaults.standard.object(forKey: Self.ratePreference) as? NSNumber
        rate = Self.clampedRate(saved?.floatValue ?? AVSpeechUtteranceDefaultSpeechRate)
        super.init()
        synthesizer.delegate = self
        synthesizer.usesApplicationAudioSession = true
        reloadVoices()
        interruptionObserver = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] notification in
            guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            Task { @MainActor in
                guard let self, self.ownsPlayback else { return }
                self.stop()
                self.error = "Озвучивание прервано. Нажмите «Озвучить», чтобы начать снова."
            }
        }
    }

    private static func clampedRate(_ value: Float) -> Float {
        guard value.isFinite else { return AVSpeechUtteranceDefaultSpeechRate }
        return min(rateRange.upperBound, max(rateRange.lowerBound, value))
    }
    func setRate(_ value: Float) {
        rate = Self.clampedRate(value)
        UserDefaults.standard.set(rate, forKey: Self.ratePreference)
    }
    func reloadVoices() {
        availableVoices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.lowercased().hasPrefix("ru") }.sorted {
            if $0.quality.rawValue != $1.quality.rawValue { return $0.quality.rawValue > $1.quality.rawValue }
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }
    /// Список голосов сервера; без связи остаётся прошлый.
    func loadServerVoices() async {
        guard let server, let token = Credentials.read(server: server),
              let voices = try? await AgentAPI(server: server).speechVoices(expectedToken: token), !voices.isEmpty else { return }
        serverVoices = voices
        if !voices.contains(where: { $0.id == serverVoice }) { serverVoice = Self.defaultServerVoice }
    }
    var selectedVoice: AVSpeechSynthesisVoice? {
        availableVoices.first(where: { $0.identifier == voiceIdentifier }) ?? availableVoices.first
    }
    static func voiceLabel(_ voice: AVSpeechSynthesisVoice) -> String {
        let quality = voice.quality == .premium ? "премиум" : voice.quality == .enhanced ? "улучшенный" : "стандартный"
        return "\(voice.name) · \(quality)"
    }
    var voiceDescription: String {
        if let voice = selectedVoice { return "Сейчас: \(Self.voiceLabel(voice))." }
        return "В списке устройства нет русского голоса. Будет использован системный голос."
    }

    /// The caller stops microphone capture before starting playback.
    func speak(_ source: String) {
        stop()
        let text = SpeechText.normalize(source)
        guard !text.isEmpty else { error = "В сообщении нет текста для озвучивания."; return }
        startPlayback(text)
    }
    /// Automatic replies wait for the preceding reply instead of cutting it off.
    func enqueue(_ source: String) {
        let text = SpeechText.normalize(source)
        guard !text.isEmpty else { return }
        guard isSpeaking else { startPlayback(text); return }
        guard queuedTexts.count < 6, queuedTexts.reduce(text.count, { $0 + $1.count }) <= 48_000 else {
            error = "Очередь озвучивания заполнена. Остальные ответы можно озвучить кнопкой у сообщения."
            return
        }
        queuedTexts.append(text)
    }
    private func startPlayback(_ text: String) {
        error = nil
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio, options: .duckOthers)
            try session.setActive(true)
            ownsPlayback = true
        } catch {
            queuedTexts = []
            utteranceID = nil
            isSpeaking = false
            isPaused = false
            releasePlayback()
            self.error = "Не удалось включить озвучивание. \(error.localizedDescription)"
            return
        }
        isSpeaking = true
        if useServerVoice, let server, let token = Credentials.read(server: server) {
            playFromServer(text, server: server, token: token)
        } else {
            speakOnDevice(text)
        }
    }
    private func speakOnDevice(_ text: String) {
        reloadVoices()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = selectedVoice
        utterance.rate = rate
        utterance.pitchMultiplier = 1
        utterance.volume = 1
        utteranceID = ObjectIdentifier(utterance)
        synthesizer.speak(utterance)
    }
    /// Same server voice as the voice conversation, played chunk by chunk.
    private func playFromServer(_ text: String, server: String, token: String) {
        let id = UUID()
        playback = id
        serverTask = Task { [weak self] in
            guard let self else { return }
            let api = AgentAPI(server: server)
            var played = false
            do {
                for chunk in VoiceConversationPolicy.chunks(text) {
                    let audio = try await api.speechAudio(chunk, voice: self.serverVoice, expectedToken: token)
                    try await self.waitUntilResumed(id)
                    let output = try AVAudioPlayer(data: audio)
                    Self.applyRate(output)
                    guard output.prepareToPlay(), output.play() else { throw AgentError.message("Не удалось воспроизвести ответ") }
                    self.player = output
                    played = true
                    while self.playback == id, output.isPlaying || self.isPaused {
                        try await Task.sleep(for: .milliseconds(100))
                    }
                    self.player = nil
                    guard self.playback == id else { return }
                }
                self.serverTask = nil
                self.advance(completed: true)
            } catch is CancellationError {
            } catch {
                guard self.playback == id else { return }
                self.player = nil
                if played {
                    self.serverTask = nil
                    self.error = "Озвучивание прервано: \(error.localizedDescription)"
                    self.advance(completed: false)
                } else {
                    // Server voice unavailable: still read the reply with the device voice.
                    do {
                        try await self.waitUntilResumed(id)
                        self.serverTask = nil
                        self.speakOnDevice(text)
                    } catch { /* Stopped while waiting to resume; do not restart speech. */ }
                }
            }
        }
    }
    private func waitUntilResumed(_ id: UUID) async throws {
        while true {
            try Task.checkCancellation()
            guard playback == id else { throw CancellationError() }
            if !isPaused { return }
            try await Task.sleep(for: .milliseconds(50))
        }
    }
    func stop() {
        queuedTexts = []
        utteranceID = nil
        playback = UUID()
        serverTask?.cancel()
        serverTask = nil
        player?.stop()
        player = nil
        synthesizer.stopSpeaking(at: .immediate)
        isSpeaking = false
        isPaused = false
        releasePlayback()
    }
    func togglePause() {
        guard isSpeaking else { return }
        if let player {
            if isPaused {
                if player.play() { isPaused = false }
            } else {
                player.pause()
                isPaused = true
            }
            return
        }
        if serverTask != nil {
            // Preparation between chunks has no AVAudioPlayer yet, but can still be paused.
            isPaused.toggle()
            return
        }
        if isPaused {
            if synthesizer.continueSpeaking() { isPaused = false }
        } else if synthesizer.pauseSpeaking(at: .immediate) { isPaused = true }
    }
    private func releasePlayback() {
        guard ownsPlayback else { return }
        ownsPlayback = false
        let session = AVAudioSession.sharedInstance()
        // A microphone may have taken over this process-wide audio session.
        guard session.category == .playback, session.mode == .spokenAudio else { return }
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
    }
    private func finished(_ id: ObjectIdentifier, completed: Bool) {
        guard utteranceID == id else { return }
        utteranceID = nil
        advance(completed: completed)
    }
    private func advance(completed: Bool) {
        if completed, !queuedTexts.isEmpty {
            startPlayback(queuedTexts.removeFirst())
            return
        }
        queuedTexts = []
        isSpeaking = false
        isPaused = false
        releasePlayback()
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self, utterance] in self?.finished(ObjectIdentifier(utterance), completed: true) }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self, utterance] in self?.finished(ObjectIdentifier(utterance), completed: false) }
    }
}

@MainActor struct VoiceSettingsView: View {
    @ObservedObject private var voice = VoiceOutput.shared
    @AppStorage(VoiceOutput.automaticPreference) private var automaticallySpeak = false
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        Form {
            Section {
                Picker("Голос", selection: $voice.useServerVoice) {
                    Text("Живой").tag(true)
                    Text("Устройства").tag(false)
                }
                .pickerStyle(.segmented)
                Toggle("Озвучивать новые ответы", isOn: $automaticallySpeak)
            } footer: {
                Text(voice.useServerVoice
                     ? "Нейросетевой голос сервера — тот же, что в голосовом разговоре. Без связи с сервером ответ прочитает голос устройства."
                     : "Ответы читает голос iPhone, например Milena. Голосовой разговор всё равно идёт живым голосом.")
            }
            if voice.useServerVoice {
                Section("Живой голос") {
                    if voice.server == nil {
                        Text("Подключите сервер, чтобы выбрать голос.").foregroundStyle(.secondary)
                    }
                    ForEach(voice.serverVoices) { item in
                        Button { voice.serverVoice = item.id; preview() } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.label).foregroundStyle(.primary)
                                    Text(item.note).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if item.id == voice.serverVoice { Image(systemName: "checkmark").foregroundStyle(.tint) }
                            }
                        }
                        .accessibilityAddTraits(item.id == voice.serverVoice ? .isSelected : [])
                    }
                }
            }
            Section {
                Picker("Голос устройства", selection: $voice.voiceIdentifier) {
                    Text("Автоматически").tag("")
                    ForEach(voice.availableVoices, id: \.identifier) { item in
                        Text(VoiceOutput.voiceLabel(item)).tag(item.identifier)
                    }
                    if !voice.voiceIdentifier.isEmpty, !voice.availableVoices.contains(where: { $0.identifier == voice.voiceIdentifier }) {
                        Text("Выбранный голос недоступен · используется автоматический").tag(voice.voiceIdentifier)
                    }
                }
            } header: {
                Text(voice.useServerVoice ? "Запасной голос" : "Голос устройства")
            } footer: {
                Text("\(voice.voiceDescription) Улучшенные и премиум-голоса появятся здесь, если они установлены в iOS.")
            }
            Section("Темп") {
                Slider(value: Binding(get: { voice.rate }, set: { voice.setRate($0) }), in: VoiceOutput.rateRange, step: 0.01)
                    .accessibilityLabel("Темп речи")
                HStack { Text("Медленнее"); Spacer(); Button("Обычный") { voice.setRate(AVSpeechUtteranceDefaultSpeechRate) }.buttonStyle(.borderless); Spacer(); Text("Быстрее") }
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section {
                if voice.isSpeaking {
                    Button(voice.isPaused ? "Продолжить" : "Пауза") { voice.togglePause() }
                    Button("Остановить") { voice.stop() }
                } else {
                    Button("Послушать голос") { preview() }
                }
                if let error = voice.error { Text(error).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Голос Агента")
        .onAppear { voice.reloadVoices() }
        .task { await voice.loadServerVoices() }
        .onChange(of: voice.useServerVoice) { _, _ in voice.stop() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { voice.reloadVoices() } }
        .onDisappear { voice.stop() }
    }
    private func preview() {
        voice.speak("Здравствуйте. Я Агент. Помогу разобраться в задаче и расскажу о результате.")
    }
}
