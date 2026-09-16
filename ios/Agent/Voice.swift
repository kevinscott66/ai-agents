import AVFoundation
import Speech
import SwiftUI

@MainActor final class VoiceInput: ObservableObject {
    @Published var recording = false
    @Published var starting = false
    @Published var text = ""
    @Published var error: String?
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "ru-RU"))
    private var hasTap = false
    private var ownsSession = false
    private var generation = UUID()
    func start() async {
        guard !recording, !starting else { return }
        stop()
        let activeGeneration = generation
        starting = true
        error = nil
        defer { if generation == activeGeneration { starting = false } }
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
        guard generation == activeGeneration, !Task.isCancelled else { return }
        let microphone = await AVAudioApplication.requestRecordPermission()
        guard generation == activeGeneration, !Task.isCancelled else { return }
        guard speech && microphone else { error = "Разрешите микрофон и распознавание речи в настройках iPhone."; return }
        guard let recognizer, recognizer.isAvailable else { error = "Распознавание речи сейчас недоступно."; return }
        do {
            text = ""
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true)
            ownsSession = true
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.addsPunctuation = true
            self.request = request
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0 else { throw AgentError.message("Микрофон недоступен") }
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
            hasTap = true
            task = recognizer.recognitionTask(with: request) { [weak self] result, failure in
                Task { @MainActor in
                    guard self?.generation == activeGeneration else { return }
                    if let result { self?.text = result.bestTranscription.formattedString }
                    if failure != nil || result?.isFinal == true { self?.stop() }
                }
            }
            engine.prepare()
            try engine.start()
            recording = true
        } catch { stop(); self.error = error.localizedDescription }
    }
    func stop() {
        let ownedSession = ownsSession
        ownsSession = false
        generation = UUID()
        engine.stop()
        if hasTap { engine.inputNode.removeTap(onBus: 0); hasTap = false }
        request?.endAudio(); task?.cancel(); task = nil; request = nil
        recording = false; starting = false
        let session = AVAudioSession.sharedInstance()
        if ownedSession && session.category == .record && session.mode == .measurement { try? session.setActive(false, options: .notifyOthersOnDeactivation) }
    }
}
