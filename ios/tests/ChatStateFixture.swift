import Foundation
struct Turn { let id: String; let status: String; let replies: [String] }
@MainActor var continuations: [CheckedContinuation<Turn, Error>] = []
@MainActor var polledServers: [String] = []
struct ConversationRecord: Codable, Identifiable { let id: String; let title: String; let updated: Double }
struct ConversationMessage: Codable, Identifiable { let seq: Int; let id: String; let role: String; let text: String }
struct ConversationIndex { let conversations: [ConversationRecord]; let running: Bool; let nextCursor: String?; let more: Bool }
struct ConversationHistory { let messages: [ConversationMessage]; let more: Bool; let running: Bool }
struct TurnRejected: Error { let message: String }
enum AgentError: Error { case message(String) }
@MainActor enum Credentials { static var token = "fixture"; static func read(server: String) -> String? { token } }
@MainActor var remoteRunning = false
@MainActor var archive: [ConversationMessage] = []
@MainActor var conversationList: [ConversationRecord] = []
struct AgentAPI {
 let server: String
 @MainActor func conversations(cursor: String? = nil, expectedToken: String? = nil) async throws -> ConversationIndex {
  let offset = Int(cursor ?? "0") ?? 0
  let page = Array(conversationList.dropFirst(offset).prefix(200))
  let more = conversationList.count > offset + page.count
  return ConversationIndex(conversations:page,running:remoteRunning,nextCursor:more ? String(offset + page.count) : nil,more:more)
 }
 @MainActor func createConversation(_ id: String, title: String, expectedToken: String? = nil) async throws { }
 @MainActor func history(_ id: String, before: Int? = nil, expectedToken: String? = nil) async throws -> ConversationHistory {
  let rows = archive.filter { $0.seq < (before ?? Int.max) }
  return ConversationHistory(messages: Array(rows.suffix(100)), more: rows.count > 100, running: remoteRunning)
 }
 @MainActor func send(_ text: String, id: String, conversationId: String? = nil, expectedToken: String? = nil) async throws -> Turn {
  try await withCheckedThrowingContinuation { continuations.append($0) }
 }
 @MainActor func poll(_ id: String, expectedToken: String? = nil) async throws -> Turn {
  polledServers.append(server)
  return Turn(id: id, status: "done", replies: [])
 }
}

// MODEL_UNDER_TEST
@main struct Check {
 @MainActor static func main() async {
  UserDefaults.standard.removeObject(forKey: "pendingTurn")
  UserDefaults.standard.removeObject(forKey: "pendingServer")
  let model = ChatModel()
  for oversized in [String(repeating: "a", count: 8_001), String(repeating: "😀", count: 4_001)] {
   model.draft = oversized
   precondition(!model.send(server: "https://one.example"))
   precondition(!model.pending && !model.busy && model.lines.isEmpty && model.draft == oversized)
   precondition(UserDefaults.standard.string(forKey: "pendingTurn") == nil && continuations.isEmpty)
  }
  model.draft = String(repeating: "😀", count: 4_000); precondition(model.send(server: "https://one.example"))
  while continuations.count < 1 { await Task.yield() }
  model.abandonWaiting()
  model.draft = "second"; model.send(server: "https://two.example")
  while continuations.count < 2 { await Task.yield() }
  continuations[0].resume(throwing: URLError(.cancelled))
  for _ in 0..<20 { await Task.yield() }
  precondition(model.busy && model.error == nil, "Stale cancellation corrupted new turn")
  continuations[1].resume(throwing: URLError(.timedOut))
  while model.busy { await Task.yield() }
  model.resume()
  while model.busy { await Task.yield() }
  precondition(polledServers == ["https://two.example"])
  precondition(!model.pending)
  conversationList = [ConversationRecord(id:"dialog-0000000001",title:"Test",updated:0)]
  archive = (1...150).map { ConversationMessage(seq:$0,id:"message-" + String($0),role:"user",text:String($0)) }
  await model.selectConversation("dialog-0000000001", server:"https://two.example")
  precondition(model.lines.count == 100 && model.moreHistory)
  let originalHistoryAnchor = model.lines.first!.id
  let originalTail = model.lines.last!.id
  await model.synchronize(server:"https://two.example",older:true)
  precondition(model.lines.count == 150 && !model.moreHistory)
  precondition(model.lines.last!.id == originalTail && model.lines.contains(where: { $0.id == originalHistoryAnchor }), "Pagination must retain scroll anchor and must not signal an appended tail")
  await model.synchronize(server:"https://two.example")
  precondition(model.lines.count == 150 && !model.moreHistory, "Refresh erased older history")
  let restored = ChatModel()
  await restored.synchronize(server:"https://two.example")
  precondition(restored.conversationId == "dialog-0000000001" && restored.lines.count == 100)
  remoteRunning = true
  await model.synchronize(server:"https://two.example")
  precondition(model.remoteBusy)
  model.newConversation(server:"https://two.example")
  remoteRunning = false
  await model.synchronize(server:"https://two.example")
  precondition(model.lines.isEmpty && model.conversationId == nil && !model.remoteBusy)
  model.draft = "old server task"; model.send(server:"https://two.example")
  while continuations.count < 3 { await Task.yield() }
  await model.synchronize(server:"https://new.example")
  continuations[2].resume(returning:Turn(id:"old",status:"done",replies:["must not appear"]))
  for _ in 0..<30 { await Task.yield() }
  precondition(!model.lines.contains(where: { $0.text == "must not appear" }), "Old server response leaked")
  precondition(model.pending && !model.busy, "Pending recovery lost on server switch")
  model.abandonWaiting()
  conversationList = (1...450).map { ConversationRecord(id:String(format:"dialog-%016d",$0),title:String($0),updated:Double(451-$0)) }
  let catalog = ChatModel()
  await catalog.synchronize(server:"https://catalog.example")
  precondition(catalog.conversations.count == 200 && catalog.moreConversations)
  await catalog.selectConversation(conversationList[449].id,server:"https://catalog.example")
  precondition(catalog.conversationId == conversationList[449].id, "Selected old dialog replaced by latest page")
  await catalog.loadMoreConversations(server:"https://catalog.example")
  precondition(catalog.conversations.count == 400 && catalog.moreConversations)
  await catalog.synchronize(server:"https://catalog.example")
  await catalog.loadMoreConversations(server:"https://catalog.example")
  precondition(catalog.conversations.count == 450 && !catalog.moreConversations)
  precondition(Set(catalog.conversations.map(\.id)).count == 450)
  for failure in ["busy", "lead_unavailable"] {
   let rejected = ChatModel(); rejected.draft = "restore this"
   let position = continuations.count
   precondition(rejected.send(server:"https://rejected.example"))
   while continuations.count <= position { await Task.yield() }
   continuations[position].resume(throwing:TurnRejected(message:failure))
   while rejected.busy { await Task.yield() }
   precondition(!rejected.pending && rejected.draft == "restore this" && rejected.lines.isEmpty)
   precondition(UserDefaults.standard.string(forKey:"pendingTurn") == nil)
  }
  print("PASS: synchronized history, pagination, restoration and cross-server isolation")
  print("PASS: stale cancellation isolation and pending-server recovery")
 }
}
