import Foundation

/// Pure preparation for spoken replies; never sends text to a remote service.
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
    static let rateRange: ClosedRange<Float> = 0.35...0.65

    @Published private(set) var isSpeaking = false
    @Published private(set) var isPaused = false
    @Published private(set) var error: String?
    @Published private(set) var availableVoices: [AVSpeechSynthesisVoice] = []
    @Published private(set) var rate: Float
    @Published var voiceIdentifier: String {
        didSet { UserDefaults.standard.set(voiceIdentifier, forKey: Self.identifierPreference) }
    }
    private let synthesizer = AVSpeechSynthesizer()
    private var utteranceID: ObjectIdentifier?
    private var queuedTexts: [String] = []
    private var ownsPlayback = false
    private var interruptionObserver: NSObjectProtocol?

    private override init() {
        voiceIdentifier = UserDefaults.standard.string(forKey: Self.identifierPreference) ?? ""
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
        reloadVoices()
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio, options: .duckOthers)
            try session.setActive(true)
            ownsPlayback = true
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = selectedVoice
            utterance.rate = rate
            utterance.pitchMultiplier = 1
            utterance.volume = 1
            utteranceID = ObjectIdentifier(utterance)
            isSpeaking = true
            synthesizer.speak(utterance)
        } catch {
            queuedTexts = []
            utteranceID = nil
            isSpeaking = false
            isPaused = false
            releasePlayback()
            self.error = "Не удалось включить озвучивание. \(error.localizedDescription)"
        }
    }
    func stop() {
        queuedTexts = []
        utteranceID = nil
        synthesizer.stopSpeaking(at: .immediate)
        isSpeaking = false
        isPaused = false
        releasePlayback()
    }
    func togglePause() {
        guard isSpeaking else { return }
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
            Section("Озвучивание ответов") {
                Toggle("Озвучивать новые ответы автоматически", isOn: $automaticallySpeak)
                Text("История при открытии диалога не озвучивается. Голос создаётся на устройстве.").font(.footnote).foregroundStyle(.secondary)
            }
            Section("Голос") {
                Picker("Русский голос", selection: $voice.voiceIdentifier) {
                    Text("Автоматически").tag("")
                    ForEach(voice.availableVoices, id: \.identifier) { item in
                        Text(VoiceOutput.voiceLabel(item)).tag(item.identifier)
                    }
                    if !voice.voiceIdentifier.isEmpty, !voice.availableVoices.contains(where: { $0.identifier == voice.voiceIdentifier }) {
                        Text("Выбранный голос недоступен · используется автоматический").tag(voice.voiceIdentifier)
                    }
                }
                Text(voice.voiceDescription).font(.footnote).foregroundStyle(.secondary)
                Text("Улучшенные и премиум-голоса появятся здесь, если они установлены в iOS.").font(.footnote).foregroundStyle(.secondary)
            }
            Section("Темп") {
                Slider(value: Binding(get: { voice.rate }, set: { voice.setRate($0) }), in: VoiceOutput.rateRange, step: 0.01)
                    .accessibilityLabel("Темп речи")
                HStack { Text("Медленнее"); Spacer(); Text("Быстрее") }.font(.caption).foregroundStyle(.secondary)
                Button("Обычный темп") { voice.setRate(AVSpeechUtteranceDefaultSpeechRate) }
            }
            Section {
                Button("Послушать голос") { voice.speak("Здравствуйте. Я Агент. Помогу разобраться в задаче и расскажу о результате.") }
                if voice.isSpeaking {
                    Button(voice.isPaused ? "Продолжить" : "Пауза") { voice.togglePause() }
                    Button("Остановить") { voice.stop() }
                }
                if let error = voice.error { Text(error).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Голос Агента")
        .onAppear { voice.reloadVoices() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { voice.reloadVoices() } }
        .onDisappear { voice.stop() }
    }
}
