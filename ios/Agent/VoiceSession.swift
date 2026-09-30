import Foundation

/// UI and transport share one phase instead of independent, potentially contradictory flags.
enum VoiceConversationPhase: Equatable {
    case stopped, connecting, listening, transcribing, waiting, preparingSpeech, speaking
    case failed(String)

    var status: String {
        switch self {
        case .stopped: return "Разговор остановлен"
        case .connecting: return "Подключаю голос…"
        case .listening: return "Слушаю вас"
        case .transcribing: return "Распознаю речь…"
        case .waiting: return "Агент думает…"
        case .preparingSpeech: return "Готовлю голос…"
        case .speaking: return "Агент говорит"
        case .failed(let message): return message
        }
    }
    var canInterrupt: Bool { self == .preparingSpeech || self == .speaking }
    var failed: Bool { if case .failed = self { return true }; return false }
}

/// Bounded, deduplicated queue; interruption invalidates even audio already being fetched.
struct VoiceReplyBuffer {
    private(set) var revision = UUID()
    private var seen: [String] = []
    private var pending: [String] = []
    var isEmpty: Bool { pending.isEmpty }

    mutating func reset(ignoring replyID: String? = nil) {
        interrupt()
        seen = replyID.map { [$0] } ?? []
    }
    /// False means capacity exceeded, not a duplicate or a non-spoken message.
    mutating func append(id: String, text: String) -> Bool {
        guard !seen.contains(id) else { return true }
        seen.append(id)
        if seen.count > 256 { seen.removeFirst(seen.count - 256) }
        let chunks = VoiceConversationPolicy.chunks(text)
        guard pending.count + chunks.count <= 24,
              pending.reduce(0, { $0 + $1.utf16.count }) + text.utf16.count <= 48_000 else { return false }
        pending.append(contentsOf: chunks)
        return true
    }
    mutating func next() -> String? { pending.isEmpty ? nil : pending.removeFirst() }
    mutating func interrupt() { revision = UUID(); pending.removeAll() }
}

/// Pure boundaries shared by capture, reply playback and deterministic regression fixtures.
enum VoiceConversationPolicy {
    static func finishedUtterance(samples: Int, silence: TimeInterval) -> Bool {
        samples >= 4 && silence >= 1.2
    }
    static func chunks(_ text: String) -> [String] {
        var result: [String] = []; var chunk = ""; var units = 0
        for character in text {
            let size = String(character).utf16.count
            if units + size > 3000 && !chunk.isEmpty { result.append(chunk); chunk = ""; units = 0 }
            if size > 3000 { continue }
            chunk.append(character); units += size
        }
        if !chunk.isEmpty { result.append(chunk) }
        return result
    }
    /// Yield a silent microphone promptly when work or a reply arrives from another client.
    static func yieldCapture(voicedSamples: Int, replyWaiting: Bool, agentBusy: Bool) -> Bool {
        voicedSamples == 0 && (replyWaiting || agentBusy)
    }
}
