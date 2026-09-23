import Foundation

let AVSpeechUtteranceDefaultSpeechRate: Float = 0.5
let AVAudioSessionInterruptionTypeKey = "interruptionType"
extension Notification.Name { static let voiceTestInterruption = Self("voice-test-interruption") }
extension AVAudioSession {
    enum InterruptionType: UInt { case began = 1, ended = 0 }
    static let interruptionNotification = Notification.Name.voiceTestInterruption
}
struct ServerVoice { let id: String; let label: String; let note: String }
@MainActor extension AgentAPI {
    func speechVoices(expectedToken: String) async throws -> [ServerVoice] { [] }
}
@MainActor final class AVSpeechSynthesisVoice {
    enum Quality: Int { case `default` = 1, enhanced = 2, premium = 3 }
    let language = "ru-RU", identifier = "test", name = "Test"
    let quality = Quality.default
    static func speechVoices() -> [AVSpeechSynthesisVoice] { [AVSpeechSynthesisVoice()] }
}
@MainActor final class AVSpeechUtterance {
    var voice: AVSpeechSynthesisVoice?
    var rate: Float = 0.5, pitchMultiplier: Float = 1, volume: Float = 1
    init(string: String) {}
}
protocol AVSpeechSynthesizerDelegate: AnyObject {}
@MainActor final class AVSpeechSynthesizer {
    enum Boundary { case immediate }
    weak var delegate: AVSpeechSynthesizerDelegate?
    var usesApplicationAudioSession = true
    static var starts = 0
    func speak(_ utterance: AVSpeechUtterance) { Self.starts += 1 }
    func stopSpeaking(at: Boundary) {}
    func pauseSpeaking(at: Boundary) -> Bool { false }
    func continueSpeaking() -> Bool { false }
}
@main struct Check {
    @MainActor static func until(_ condition: () -> Bool) async {
        for _ in 0..<200 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        preconditionFailure("Playback did not reach expected state")
    }
    @MainActor static func main() async {
        defer { testDefaults.removePersistentDomain(forName: testDomain) }
        let voice = VoiceOutput.shared
        voice.server = "test"; voice.useServerVoice = true
        AgentAPI.holdSpeech = true
        voice.speak("response")
        await until { AgentAPI.pending != nil }
        voice.togglePause()
        precondition(voice.isPaused)
        AgentAPI.pending?.resume(returning: Data([1])); AgentAPI.pending = nil
        try? await Task.sleep(for: .milliseconds(100))
        precondition(AVAudioPlayer.plays == 0, "Prepared audio ignored pause")
        voice.togglePause()
        await until { AVAudioPlayer.plays == 1 }
        voice.stop()

        // A provider failure while paused must not start the device fallback until resume.
        voice.speak("fallback")
        await until { AgentAPI.pending != nil }
        voice.togglePause()
        AgentAPI.pending?.resume(throwing: AgentError.message("unavailable")); AgentAPI.pending = nil
        try? await Task.sleep(for: .milliseconds(100))
        precondition(AVSpeechSynthesizer.starts == 0 && voice.isPaused)
        voice.togglePause()
        await until { AVSpeechSynthesizer.starts == 1 }
        voice.stop()

        // Stop wins over a late provider failure; no fallback after the user stopped speech.
        voice.speak("late")
        await until { AgentAPI.pending != nil }
        voice.stop()
        AgentAPI.pending?.resume(throwing: AgentError.message("late")); AgentAPI.pending = nil
        try? await Task.sleep(for: .milliseconds(100))
        precondition(!voice.isSpeaking && AVSpeechSynthesizer.starts == 1 && AVAudioPlayer.plays == 1)
        print("PASS: neural playback pause during preparation, paused device fallback and stopped-request isolation")
    }
}
