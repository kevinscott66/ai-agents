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
        let validToken = try Pairing(token: String(repeating: "a", count: 64), userId: "1").validatedToken()
        precondition(validToken.count == 64)
        for invalid in [String(repeating: "a", count: 63), String(repeating: "G", count: 64), String(repeating: "a", count: 63) + "\n"] {
            rejects { _ = try Pairing(token: invalid, userId: "1").validatedToken() }
        }
        precondition(AgentAPI.conversationTitle(String(repeating: "😀", count: 60)) == String(repeating: "😀", count: 50))
        // Озвучка: куски склеиваются обратно без потерь, каждый влезает в серверный лимит UTF-16, режется по пробелу.
        let spoken = String(repeating: "Проверка голоса агента. ", count: 400) + String(repeating: "😀", count: 3_000)
        let chunks = AgentAPI.speechChunks(spoken)
        precondition(chunks.joined() == spoken && chunks.count > 2)
        precondition(chunks.allSatisfy { !$0.isEmpty && $0.utf16.count <= AgentAPI.speechTextLimit / 2 })
        precondition(chunks[0].last == " ")
        precondition(AgentAPI.speechChunks("коротко") == ["коротко"] && AgentAPI.speechChunks("").isEmpty)
        precondition(AgentAPI.speechChunks(String(repeating: "я", count: 10), limit: 4).joined() == String(repeating: "я", count: 10))
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
