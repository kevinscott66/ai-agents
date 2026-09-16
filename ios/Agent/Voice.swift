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
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
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
        generation = UUID()
        engine.stop()
        if hasTap { engine.inputNode.removeTap(onBus: 0); hasTap = false }
        request?.endAudio(); task?.cancel(); task = nil; request = nil
        recording = false; starting = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

/// Озвучивает ответы чата тем же серверным голосом, что и голосовой разговор.
@MainActor final class ReplySpeaker: NSObject, AVAudioPlayerDelegate {
    private var player: AVAudioPlayer?
    private var finished: CheckedContinuation<Void, Never>?
    private var task: Task<Void, Never>?
    func speak(_ text: String, server: String, token: String, failed: @escaping (String) -> Void) {
        stop()
        task = Task {
            do {
                for chunk in AgentAPI.speechChunks(text) {
                    let audio = try await AgentAPI(server: server).speech(chunk, expectedToken: token)
                    try Task.checkCancellation()
                    try await play(audio)
                    try Task.checkCancellation()
                }
            } catch is CancellationError {
            } catch {
                if !Task.isCancelled { failed(error.localizedDescription) }
            }
            if !Task.isCancelled { release() }
        }
    }
    private func play(_ audio: Data) async throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio)
        try session.setActive(true)
        let player = try AVAudioPlayer(data: audio)
        player.delegate = self
        self.player = player
        await withCheckedContinuation { continuation in
            finished = continuation
            if Task.isCancelled || !player.play() { resume() }
        }
    }
    private func resume() { let continuation = finished; finished = nil; continuation?.resume() }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { Task { @MainActor in self.resume() } }
    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) { Task { @MainActor in self.resume() } }
    private func release() {
        player?.stop(); player = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    func stop() {
        task?.cancel(); task = nil
        resume()
        release()
    }
}
