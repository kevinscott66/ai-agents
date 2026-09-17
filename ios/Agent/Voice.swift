import AVFoundation
import Speech
import SwiftUI

/// Гибридная диктовка: пока пользователь говорит, текст даёт распознавание на устройстве;
/// после стопа та же запись уходит на сервер, и более точный вариант заменяет черновик,
/// только если пользователь не успел его поправить.
enum DictationDraft {
    /// Короче этого запись не отправляем: в ней нет речи, а модель на тишине выдумывает текст.
    static let minimumSeconds = 0.6
    static func replacement(draft: String, spoken: String, refined: String) -> String? {
        let refined = refined.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !refined.isEmpty, draft == spoken, refined != draft else { return nil }
        return refined
    }
}

/// Пишет буферы микрофона в m4a. Тап вызывается на аудиопотоке, поэтому доступ под замком;
/// файл закрывается, когда отпускаем ссылку на AVAudioFile (close() есть только с iOS 18).
/// AVAudioFile не пересэмплирует: частота и каналы файла совпадают с микрофоном, битрейт выбирает кодек.
final class DictationRecording: @unchecked Sendable {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("dictation-" + UUID().uuidString + ".m4a")
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var frames: AVAudioFramePosition = 0
    private let sampleRate: Double
    init(format: AVAudioFormat) throws {
        sampleRate = format.sampleRate
        file = try AVAudioFile(forWriting: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: format.sampleRate, AVNumberOfChannelsKey: format.channelCount, AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue], commonFormat: format.commonFormat, interleaved: format.isInterleaved)
    }
    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        guard let file else { return }
        do { try file.write(from: buffer); frames += AVAudioFramePosition(buffer.frameLength) } catch { self.file = nil }
    }
    /// Закрывает файл и возвращает запись, если в ней достаточно звука.
    func finish() -> Data? {
        lock.lock(); let seconds = Double(frames) / max(sampleRate, 1); file = nil; lock.unlock()
        defer { discard() }
        guard seconds >= DictationDraft.minimumSeconds else { return nil }
        return try? Data(contentsOf: url)
    }
    func discard() {
        lock.lock(); file = nil; lock.unlock()
        try? FileManager.default.removeItem(at: url)
    }
}

@MainActor final class VoiceInput: ObservableObject {
    @Published var recording = false
    @Published var starting = false
    @Published var text = ""
    @Published var error: String?
    /// Запись ушла на сервер, ждём уточнённый текст.
    @Published var refining = false
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "ru-RU"))
    private var hasTap = false
    private var ownsSession = false
    private var generation = UUID()
    private var capture: DictationRecording?
    private var refine: ((Data) async throws -> String)?
    private var apply: ((_ spoken: String, _ refined: String) -> Void)?
    private var refinement: Task<Void, Never>?
    /// refine отправляет запись на сервер; apply получает то, что было распознано на устройстве,
    /// и серверный вариант — и сам решает, можно ли заменить черновик.
    func start(refine: ((Data) async throws -> String)? = nil, apply: ((_ spoken: String, _ refined: String) -> Void)? = nil) async {
        guard !recording, !starting else { return }
        stop()
        self.refine = refine; self.apply = apply
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
            let dictation = refine == nil ? nil : try? DictationRecording(format: format)
            capture = dictation
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer); dictation?.append(buffer) }
            hasTap = true
            task = recognizer.recognitionTask(with: request) { [weak self] result, failure in
                Task { @MainActor in
                    guard self?.generation == activeGeneration else { return }
                    if let result { self?.text = result.bestTranscription.formattedString }
                    if failure != nil || result?.isFinal == true { self?.finish() }
                }
            }
            engine.prepare()
            try engine.start()
            recording = true
        } catch { stop(); self.error = error.localizedDescription }
    }
    /// Пользователь закончил диктовку: остановить микрофон и уточнить текст на сервере.
    /// В отличие от stop(), который отменяет всё, включая уже идущее уточнение.
    func finish() {
        guard recording || starting else { return }
        let dictation = capture, refine = self.refine, apply = self.apply, spoken = text
        capture = nil
        stop()
        guard let dictation else { return }
        guard let refine, let apply else { dictation.discard(); return }
        let activeGeneration = generation
        refining = true
        refinement = Task { [weak self] in
            defer { if self?.generation == activeGeneration { self?.refining = false } }
            guard let data = dictation.finish() else { return }
            guard let refined = try? await refine(data), !Task.isCancelled, self?.generation == activeGeneration else { return }
            apply(spoken, refined)
        }
    }
    func stop() {
        refinement?.cancel(); refinement = nil; refining = false
        capture?.discard(); capture = nil
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
