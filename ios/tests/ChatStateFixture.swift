import Foundation
struct Turn { let id: String; let status: String; let replies: [String] }
@MainActor var continuations: [CheckedContinuation<Turn, Error>] = []
@MainActor var polledServers: [String] = []
struct ConversationRecord: Codable, Identifiable { let id: String; let title: String; let updated: Double }
struct ConversationMessage: Codable, Identifiable { let seq: Int; let id: String; let role: String; let text: String }
struct ConversationIndex { let conversations: [ConversationRecord]; let running: Bool }
struct ConversationHistory { let messages: [ConversationMessage]; let more: Bool; let running: Bool }
enum AgentError: Error { case message(String) }
@MainActor enum Credentials { static var token = "fixture"; static func read(server: String) -> String? { token } }
@MainActor var remoteRunning = false
@MainActor var archive: [ConversationMessage] = []
@MainActor var conversationList: [ConversationRecord] = []
struct AgentAPI {
 let server: String
 @MainActor func conversations(expectedToken: String? = nil) async throws -> ConversationIndex { ConversationIndex(conversations:conversationList,running:remoteRunning) }
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
  model.draft = "first"; model.send(server: "https://one.example")
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
  await model.synchronize(server:"https://two.example",older:true)
  precondition(model.lines.count == 150 && !model.moreHistory)
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
  print("PASS: synchronized history, pagination, restoration and cross-server isolation")
  print("PASS: stale cancellation isolation and pending-server recovery")
 }
}
