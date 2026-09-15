import Foundation
struct Turn { let id: String; let status: String; let replies: [String] }
@MainActor var continuations: [CheckedContinuation<Turn, Error>] = []
@MainActor var polledServers: [String] = []
struct AgentAPI {
 let server: String
 @MainActor func send(_ text: String, id: String) async throws -> Turn {
  try await withCheckedThrowingContinuation { continuations.append($0) }
 }
 @MainActor func poll(_ id: String) async throws -> Turn {
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
  print("PASS: stale cancellation isolation and pending-server recovery")
 }
}
