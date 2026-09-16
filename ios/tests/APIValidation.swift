import Foundation
struct ByteFixture: AsyncSequence, AsyncIteratorProtocol {
    typealias Element = UInt8
    var remaining: Int
    mutating func next() async -> UInt8? {
        guard remaining > 0 else { return nil }
        remaining -= 1
        return 65
    }
    func makeAsyncIterator() -> ByteFixture { self }
}
@main struct Check {
    static func rejects(_ work: () throws -> Void) {
        do { try work(); preconditionFailure("Expected rejection") } catch { }
    }
    static func main() async throws {
        for status in ["running", "done", "error", "interrupted"] {
            _ = try Turn(id: "expected", status: status, replies: [String(repeating: "😀", count: 4_000)]).validated(for: "expected")
        }
        rejects { _ = try Turn(id: "wrong", status: "done", replies: []).validated(for: "expected") }
        rejects { _ = try Turn(id: "expected", status: "unknown", replies: []).validated(for: "expected") }
        rejects { _ = try Turn(id: "expected", status: "done", replies: Array(repeating: "", count: 81)).validated(for: "expected") }
        rejects { _ = try Turn(id: "expected", status: "done", replies: [String(repeating: "😀", count: 4_001)]).validated(for: "expected") }
        rejects { _ = try JSONDecoder().decode(Turn.self, from: Data(#"{"id":"expected","status":"done","replies":[1]}"#.utf8)) }
        let legacy = try JSONDecoder().decode(Turn.self, from: Data(#"{"id":"expected","status":"done","replies":[]}"#.utf8))
        precondition(legacy.outputMedia == nil && legacy.generations == nil)
        let media = NativeAttachment(id: "attachment-00000001", name: "image.png", mimeType: "image/png", size: 123)
        let output = NativeOutputMedia(messageId: "expected:reply:1", attachments: [media])
        let job = NativeGeneration(id: UUID().uuidString, state: "running", started: 1)
        _ = try Turn(id: "expected", status: "running", replies: [""], outputMedia: [output], generations: [job]).validated(for: "expected")
        rejects { _ = try Turn(id: "expected", status: "done", replies: [], outputMedia: [output]).validated(for: "expected") }
        rejects { _ = try Turn(id: "expected", status: "done", replies: [""], outputMedia: [output, output]).validated(for: "expected") }
        rejects { _ = try Turn(id: "expected", status: "running", replies: [], generations: [NativeGeneration(id: job.id, state: "guessed", started: 1)]).validated(for: "expected") }
        try AgentAPI.validateCredential("same", expected: "same")
        try AgentAPI.validateCredential(nil, expected: nil)
        rejects { try AgentAPI.validateCredential("changed", expected: "original") }
        rejects { try AgentAPI.validateCredential(nil, expected: "original") }
        let detail = NativeReplyDetail(messageId: "expected:reply:1", agentKey: "qa")
        _ = try Turn(id: "expected", status: "done", replies: ["Reviewed"], replyDetails: [detail]).validated(for: "expected")
        rejects { _ = try Turn(id: "expected", status: "done", replies: ["Reviewed"], replyDetails: [detail, detail]).validated(for: "expected") }
        rejects { _ = try Turn(id: "expected", status: "done", replies: ["Reviewed"], replyDetails: [NativeReplyDetail(messageId:"other:reply:1",agentKey:"qa")]).validated(for:"expected") }
        precondition(AgentRole.name(nil) == "Агент" && AgentRole.name("unknown") == "Агент" && AgentRole.name("qa") == "Тестирование")
        let snapshot = try JSONDecoder().decode(KnowledgeSnapshot.self, from: Data(#"{"revision":2,"entries":[{"id":"fact-1","kind":"fact","text":"A fact","sourceMessageIds":["turn:reply:1"]}],"project":{"id":"project-00000001","title":"Project","created":1,"updated":2},"projectEntries":[],"proposals":[{"id":"proposal-0000001","projectId":"project-00000001","conversationId":"dialog-000000001","revision":2,"entry":{"id":"fact-1","kind":"fact","text":"A fact","sourceMessageIds":["turn:reply:1"]}}]}"#.utf8))
        let projectFactA = KnowledgeEntry(id:"fact",kind:"fact",text:"A",sourceMessageIds:[],sourceConversationId:"chat-a")
        let projectFactB = KnowledgeEntry(id:"fact",kind:"fact",text:"B",sourceMessageIds:[],sourceConversationId:"chat-b")
        precondition(projectFactA.projectIdentity != projectFactB.projectIdentity)
        precondition(snapshot.proposals.first?.entry.text == "A fact" && snapshot.entries.first?.sourceMessageIds == ["turn:reply:1"])
        precondition(try! AgentAPI.knowledgeRoute("dialog-000000001") == "/api/native/conversations/dialog-000000001/knowledge")
        rejects { _ = try AgentAPI.knowledgeRoute("../projects") }
        precondition(try! AgentAPI.knowledgeRoute("knowledge-000000001", resource: "project") == "/api/native/conversations/knowledge-000000001/project")
        print("PASS: role metadata identity, legacy role fallback and scoped knowledge contract")
        let validToken = try Pairing(token: String(repeating: "a", count: 64), userId: "1").validatedToken()
        precondition(validToken.count == 64)
        for invalid in [String(repeating: "a", count: 63), String(repeating: "G", count: 64), String(repeating: "a", count: 63) + "\n"] {
            rejects { _ = try Pairing(token: invalid, userId: "1").validatedToken() }
        }
        precondition(AgentAPI.conversationTitle(String(repeating: "😀", count: 60)) == String(repeating: "😀", count: 50))
        precondition(AgentAPI.conversationTitle(String(repeating: "a", count: 99) + "😀").utf16.count == 99)
        precondition(AgentAPI.conversationTitle(String(repeating: "a", count: 101)).utf16.count == 100)
        for (status, reason) in [(409,"busy"),(409,"conflict"),(503,"lead_unavailable"),(401,"unauthorized")] {
            precondition(AgentAPI.turnWasRejected(status:status,data:Data("{\"error\":\"\(reason)\"}".utf8)))
        }
        for (status, body) in [(503,"<html>proxy unavailable</html>"),(500,"{\"error\":\"lead_unavailable\"}"),(503,"{\"error\":\"unknown\"}"),(409,"{}")] {
            precondition(!AgentAPI.turnWasRejected(status:status,data:Data(body.utf8)))
        }
        let exact = try await AgentAPI.readBody(ByteFixture(remaining: AgentAPI.maximumResponseBytes))
        precondition(exact.count == AgentAPI.maximumResponseBytes)
        do {
            _ = try await AgentAPI.readBody(ByteFixture(remaining: AgentAPI.maximumResponseBytes + 1))
            preconditionFailure("Expected oversized response rejection")
        } catch { }
        print("PASS: 4 MiB boundary, turn ID/status/reply UTF16 validation, pairing token validation")
    }
}
