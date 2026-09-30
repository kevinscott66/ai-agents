import AVFoundation
import Speech
import Combine

@MainActor final class Voice: ObservableObject {
    @Published var listening = false
    @Published var transcript = ""
    @Published var error = ""
    @Published var armed = false
    @Published var wakeDraft = ""
    @Published var speaking = false
    private var wakeGeneration = UUID()
    private var wakeTask: Task<Void,Never>?
    private var speechTask: Task<Void,Never>?
    private var player: AVAudioPlayer?
    private var speechGeneration = UUID()
    func setWake(_ enabled: Bool) {
        wakeGeneration = UUID(); let ticket = wakeGeneration
        wakeTask?.cancel(); armed = enabled; stop()
        guard enabled else { return }
        wakeDraft = ""
        wakeTask = Task {
            while armed && !Task.isCancelled && ticket == wakeGeneration {
                await start()
                guard ticket == wakeGeneration, !Task.isCancelled else { return }
                if !error.isEmpty { armed = false; break }
                var last = ""; var changed = Date()
                while listening && !Task.isCancelled && armed {
                    if transcript != last { last = transcript; changed = Date() }
                    if Date().timeIntervalSince(changed) > 1.4 && !last.isEmpty { break }
                    try? await Task.sleep(for:.milliseconds(150))
                }
                guard ticket == wakeGeneration, !Task.isCancelled else { return }
                let text = transcript.trimmingCharacters(in:.whitespacesAndNewlines)
                let prefix = UserDefaults.standard.string(forKey:"wakePhrase") ?? "Агент"
                if !prefix.isEmpty, text.lowercased().hasPrefix(prefix.lowercased()+" ") || text.lowercased().hasPrefix(prefix.lowercased()+",") {
                    wakeDraft = String(text.dropFirst(prefix.count)).trimmingCharacters(in:.punctuationCharacters.union(.whitespacesAndNewlines))
                    armed = false; stop(); break
                }
                stop(); try? await Task.sleep(for:.milliseconds(300))
            }
        }
    }
    func stopSpeaking() {
        speechGeneration = UUID(); speechTask?.cancel(); speechTask = nil; player?.stop(); player = nil
        speaker.stopSpeaking(at:.immediate); speaking = false
    }
    func read(_ text: String, server: String) {
        setWake(false); stopSpeaking()
        let provider = UserDefaults.standard.string(forKey:"speechProvider") ?? "system"
        let ticket = speechGeneration
        speaking = true
        speechTask = Task {
            do {
                if provider == "system" {
                    speak(String(text.prefix(4000)),voice:UserDefaults.standard.string(forKey:"systemVoice") ?? "")
                    while speaker.isSpeaking && !Task.isCancelled { try await Task.sleep(for:.milliseconds(100)) }
                } else {
                    let data: Data
                    if provider == "server" {
                        let api = AgentService(server:try secureServer(server),token:Vault.read(server))
                        data = try await api.call("voice/speech",body:["text":String(text.prefix(4000)),"voice":UserDefaults.standard.string(forKey:"serverVoice") ?? "marin"])
                    } else {
                        let key = Vault.read("fish-audio")
                        let reference = UserDefaults.standard.string(forKey:"fishVoice") ?? ""
                        guard !key.isEmpty, !reference.isEmpty else { throw DesktopError.message("Укажите ключ Fish Audio и ID голоса в настройках") }
                        var request = URLRequest(url:URL(string:"https://api.fish.audio/v1/tts")!); request.httpMethod = "POST"; request.timeoutInterval = 40
                        request.setValue("Bearer " + key,forHTTPHeaderField:"Authorization");request.setValue("application/json",forHTTPHeaderField:"Content-Type");request.setValue("s2.1-pro-free",forHTTPHeaderField:"model")
                        request.httpBody = try JSONSerialization.data(withJSONObject:["text":String(text.prefix(4000)),"reference_id":reference,"format":"mp3"])
                        let session = URLSession(configuration:.ephemeral,delegate:NoRedirect(),delegateQueue:nil); defer { session.invalidateAndCancel() }
                        let (raw,response) = try await session.data(for:request)
                        guard (response as? HTTPURLResponse)?.statusCode == 200, raw.count <= 8_000_000 else { throw DesktopError.message("Fish Audio не вернул озвучку. Проверьте ключ и доступность голоса.") }
                        data = raw
                    }
                    try Task.checkCancellation(); guard ticket == speechGeneration else { return }
                    let audio = try AVAudioPlayer(data:data); player = audio
                    guard audio.play() else { throw DesktopError.message("Не удалось воспроизвести голос") }
                    while audio.isPlaying && !Task.isCancelled { try await Task.sleep(for:.milliseconds(100)) }
                }
            } catch is CancellationError {} catch { if ticket == speechGeneration { self.error = error.localizedDescription } }
            if ticket == speechGeneration { speaking = false }
        }
    }
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognition: SFSpeechRecognitionTask?
    private var generation = UUID()
    private var timer: Task<Void, Never>?
    let speaker = AVSpeechSynthesizer()
    func stop() {
        generation = UUID(); timer?.cancel(); timer = nil
        if listening { engine.stop(); engine.inputNode.removeTap(onBus: 0) }
        listening = false; request?.endAudio(); recognition?.cancel(); recognition = nil; request = nil
    }
    func start() async {
        stop(); stopSpeaking(); error = ""; transcript = ""
        let ticket = generation
        let speech = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
        let audio = await AVCaptureDevice.requestAccess(for: .audio)
        guard ticket == generation else { return }
        guard speech == .authorized, audio else { error = "Разрешите микрофон и распознавание речи в настройках macOS"; return }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "ru-RU")), recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else { error = "Локальное распознавание русского языка недоступно на этом Mac"; return }
        let req = SFSpeechAudioBufferRecognitionRequest(); req.requiresOnDeviceRecognition = true; req.shouldReportPartialResults = true
        let node = engine.inputNode; let format = node.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { error = "Микрофон недоступен"; return }
        node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in req.append(buffer) }
        request = req; listening = true
        do { engine.prepare(); try engine.start() } catch { self.error = error.localizedDescription; stop(); return }
        recognition = recognizer.recognitionTask(with: req) { [weak self] result, failure in
            Task { @MainActor in
                guard let self, self.generation == ticket else { return }
                if let result { self.transcript = result.bestTranscription.formattedString; if result.isFinal { self.stop() } }
                if let failure { self.error = failure.localizedDescription; self.stop() }
            }
        }
        timer = Task { try? await Task.sleep(for: .seconds(55)); if !Task.isCancelled { stop() } }
    }
    func speak(_ text: String, voice: String) {
        stop(); speaker.stopSpeaking(at: .immediate)
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(identifier: voice) ?? AVSpeechSynthesisVoice(language: "ru-RU")
        speaker.speak(utterance)
    }
}
