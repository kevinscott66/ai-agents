import Foundation

// Platform fakes exercise the production controller, including suspended, cancellation-ignoring I/O.
let AVFormatIDKey = "format", AVSampleRateKey = "rate", AVNumberOfChannelsKey = "channels", AVEncoderBitRateKey = "bits"
let kAudioFormatMPEG4AAC = 1
struct ChatLine { let id: String; let text: String }
enum AgentError: LocalizedError { case message(String); var errorDescription: String? { if case .message(let s) = self { return s }; return nil } }
@MainActor enum Credentials { static var token: String? = "owner"; static func read(server: String) -> String? { token } }
@MainActor final class ChatModel {
    var conversationId: String? = "conversation-a"
    var newReplyForSpeech: ChatLine?
    var busy = false, pending = false, remoteBusy = false
    var error: String?
    var draft = "", attachments: [String] = []
    var location: String?
    var sends = 0
    func send(server: String) -> Bool { sends += 1; draft = ""; busy = true; return true }
}
@MainActor enum VoiceOutput { static let serverVoiceID = "marin"; static func applyRate(_ player: AVAudioPlayer) {} }
enum SpeechText { static func normalize(_ text: String) -> String { text } }
@MainActor struct AgentAPI {
    let server: String
    static var speechCalls = 0, transcriptions = 0
    static var pending: CheckedContinuation<Data, Error>?
    static var pendingTranscript: CheckedContinuation<String, Error>?
    static var holdSpeech = false, holdTranscript = false
    func voiceAvailable(expectedToken: String) async throws -> Bool { true }
    func speechAudio(_ text: String, voice: String, expectedToken: String) async throws -> Data {
        Self.speechCalls += 1
        if Self.holdSpeech { return try await withCheckedThrowingContinuation { Self.pending = $0 } }
        return Data([1])
    }
    func transcribeVoice(_ data: Data, expectedToken: String) async throws -> String {
        Self.transcriptions += 1
        if Self.holdTranscript { return try await withCheckedThrowingContinuation { Self.pendingTranscript = $0 } }
        return "hello"
    }
}
@MainActor enum AVAudioApplication { static func requestRecordPermission() async -> Bool { true } }
@MainActor final class AVAudioSession {
    enum Category { case playAndRecord, playback }
    enum Mode { case voiceChat, spokenAudio }
    struct Options: OptionSet {
        let rawValue: Int
        static let defaultToSpeaker = Self(rawValue: 1), allowBluetooth = Self(rawValue: 2), notifyOthersOnDeactivation = Self(rawValue: 4)
    }
    static let shared = AVAudioSession()
    var category = Category.playAndRecord, mode = Mode.voiceChat
    var active = false
    static func sharedInstance() -> AVAudioSession { shared }
    func setCategory(_ category: Category, mode: Mode, options: Options) throws { self.category = category; self.mode = mode }
    func setActive(_ value: Bool, options: Options = []) throws { active = value }
}
@MainActor final class AVAudioRecorder {
    static var powers: [Float] = [], created: [URL] = []
    var isMeteringEnabled = false, isRecording = false
    init(url: URL, settings: [String: Any]) throws { try Data([1]).write(to: url); Self.created.append(url) }
    func record() -> Bool { isRecording = true; return true }
    func stop() { isRecording = false }
    func updateMeters() {}
    func averagePower(forChannel: Int) -> Float { Self.powers.isEmpty ? -160 : Self.powers.removeFirst() }
}
@MainActor final class AVAudioPlayer {
    static var plays = 0
    var isMeteringEnabled = false, isPlaying = false
    init(data: Data) throws {}
    func prepareToPlay() -> Bool { true }
    func play() -> Bool { Self.plays += 1; isPlaying = true; return true }
    func stop() { isPlaying = false }
    func updateMeters() {}
    func averagePower(forChannel: Int) -> Float { -20 }
}

@main struct Check {
    @MainActor static func until(_ condition: () -> Bool) async {
        for _ in 0..<300 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        preconditionFailure("Voice controller did not reach expected state")
    }
    @MainActor static func main() async {
        precondition(!VoiceConversationPolicy.finishedUtterance(samples: 3, silence: 2))
        precondition(!VoiceConversationPolicy.finishedUtterance(samples: 4, silence: 1.19))
        precondition(VoiceConversationPolicy.finishedUtterance(samples: 4, silence: 1.2))
        let original = String(repeating: "Привет 👨‍👩‍👧‍👦. ", count: 900)
        let chunks = VoiceConversationPolicy.chunks(original)
        precondition(chunks.count > 1 && chunks.joined() == original)
        precondition(chunks.allSatisfy { $0.utf16.count <= 3000 })
        precondition(!VoiceConversationPolicy.yieldCapture(voicedSamples: 4, replyWaiting: true, agentBusy: false))
        var queue = VoiceReplyBuffer()
        queue.reset(ignoring: "old")
        precondition(queue.append(id: "old", text: "old") && queue.isEmpty)
        precondition(queue.append(id: "new", text: original))
        precondition(queue.append(id: "new", text: "duplicate"))
        var drained = ""
        while let chunk = queue.next() { drained += chunk }
        precondition(drained == original)
        let revision = queue.revision
        queue.interrupt(); precondition(queue.revision != revision)
        precondition(!queue.append(id: "oversize", text: String(repeating: "x", count: 48_001)))
        precondition(queue.isEmpty)

        let model = ChatModel(), voice = ConversationVoice()
        AgentAPI.holdSpeech = true
        voice.start(model: model, server: "test")
        await until { voice.phase == .listening }
        // Reply arrives during silence: do not wait for the 60-second capture limit.
        voice.receive(ChatLine(id: "first", text: "reply"))
        await until { AgentAPI.pending != nil }
        precondition(voice.canInterrupt && voice.phase == .preparingSpeech)
        precondition(AgentAPI.transcriptions == 0)
        voice.interrupt()
        AgentAPI.pending?.resume(returning: Data([1])); AgentAPI.pending = nil
        await until { voice.phase == .listening }
        precondition(AVAudioPlayer.plays == 0, "Interrupted fetch resumed playback")
        precondition(!voice.failed)

        AgentAPI.holdSpeech = false
        voice.receive(ChatLine(id: "second", text: "new reply"))
        await until { voice.speaking }
        voice.interrupt()
        await until { voice.phase == .listening }
        precondition(AVAudioPlayer.plays == 1)

        // A late fetch from a stopped session cannot speak or destroy the restarted session.
        AgentAPI.holdSpeech = true
        voice.receive(ChatLine(id: "third", text: "late"))
        await until { AgentAPI.pending != nil }
        let oldRequest = AgentAPI.pending; AgentAPI.pending = nil
        voice.stop(); voice.start(model: model, server: "test")
        await until { voice.phase == .listening }
        oldRequest?.resume(returning: Data([1]))
        try? await Task.sleep(for: .milliseconds(100))
        precondition(voice.phase == .listening && AVAudioPlayer.plays == 1)

        // Context changes are checked before dispatch even if the SwiftUI callback has not run.
        AgentAPI.holdTranscript = true
        AVAudioRecorder.powers = [-20, -20, -20, -20]
        await until { AgentAPI.pendingTranscript != nil }
        model.conversationId = "conversation-b"
        AgentAPI.pendingTranscript?.resume(returning: "wrong dialog"); AgentAPI.pendingTranscript = nil
        await until { voice.failed }
        precondition(model.sends == 0 && model.draft.isEmpty)

        // Concurrent remote work preserves recognized speech as a draft instead of losing it.
        voice.start(model: model, server: "test")
        await until { voice.phase == .listening }
        AVAudioRecorder.powers = [-20, -20, -20, -20]
        await until { AgentAPI.pendingTranscript != nil }
        model.remoteBusy = true
        AgentAPI.pendingTranscript?.resume(returning: "keep my words"); AgentAPI.pendingTranscript = nil
        await until { voice.failed }
        precondition(model.sends == 0 && model.draft == "keep my words")
        voice.stop()
        precondition(!AVAudioSession.shared.active)
        precondition(AVAudioRecorder.created.allSatisfy { !FileManager.default.fileExists(atPath: $0.path) })
        print("PASS: voice queue, interruption during TTS, late callbacks, silent capture, conversation isolation, draft preservation and recording cleanup")
    }
}
