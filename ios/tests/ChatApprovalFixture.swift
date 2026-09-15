import Foundation
@MainActor enum Fixture {
 static var token = "test"
 static var posts = 0
 static var status = "pending"
 static var execution: String?
 static var fail = false
 static var suspended: CheckedContinuation<Void,Never>?
 static var hold = false
 static var item: String { "{\"id\":\"approval-1\",\"chat_id\":123456,\"requested_by\":\"lead\",\"action_type\":\"MAC_RUN_CLAUDE\",\"status\":\"\(status)\",\"execution\":\(execution.map { "\""+$0+"\"" } ?? "null"),\"payload\":{\"provider\":\"codex\"}}" }
}
@MainActor struct Credentials { static func read(server: String) -> String? { Fixture.token } }
struct AgentAPI { let server: String; func ownerID(expectedToken: String? = nil) async throws -> String { "123456" } }
enum AgentError: LocalizedError { case message(String); var errorDescription: String? { if case .message(let s) = self { s } else { nil } } }
@MainActor enum PanelTransport {
 static func request(server: String, path: String, method: String, body: String?, expectedToken: String? = nil) async throws -> [String: Any] {
  if method == "GET" { return ["status":200,"body":"{\"approvals\":[" + Fixture.item + "]}"] }
  Fixture.posts += 1
  if Fixture.hold { await withCheckedContinuation { Fixture.suspended = $0 } }
  if Fixture.fail { throw AgentError.message("network") }
  Fixture.status = "approved"
  return ["status":200,"body":"{\"approval\":" + Fixture.item + ",\"executed\":true,\"result\":{\"output\":\"Тест\"}}"]
 }
}
// MODEL
@main struct Test {
 @MainActor static func main() async {
  let dialog="native-dialog-0001"
  let model = ChatApprovals(); await model.refresh(server:"https://test",conversation:dialog)
  precondition(model.items.count == 1)
  await model.decide(model.items[0], approve:true, server:"https://wrong")
  precondition(Fixture.posts == 0)
  await model.refresh(server:"https://test",conversation:dialog)
  await model.decide(model.items[0], approve:true, server:"https://test")
  await model.decide(model.items[0], approve:true, server:"https://test")
  precondition(Fixture.posts == 1 && !model.outcomes["approval-1"]!.contains("Тест"))
  Fixture.status = "pending"; Fixture.fail = true; Fixture.hold = true
  let concurrent = ChatApprovals(); await concurrent.refresh(server:"https://test",conversation:dialog)
  let task = Task { await concurrent.decide(concurrent.items[0],approve:true,server:"https://test") }
  while Fixture.suspended == nil { await Task.yield() }
  Fixture.status = "approved"; Fixture.execution = "completed"
  await concurrent.refresh(server:"https://test",conversation:dialog)
  let completed = concurrent.outcomes["approval-1"]
  Fixture.suspended?.resume(); Fixture.suspended = nil
  await task.value
  precondition(concurrent.outcomes["approval-1"] == completed && completed!.contains("Выполнено"))
  let relaunched = ChatApprovals(); await relaunched.refresh(server:"https://test",conversation:dialog)
  precondition(relaunched.items.count == 1 && relaunched.outcomes["approval-1"] == completed)
  let card = relaunched.items[0]; Fixture.token = "different-account"
  await relaunched.decide(card,approve:true,server:"https://test")
  precondition(Fixture.posts == 2 && relaunched.items.isEmpty)
  await concurrent.refresh(server:"https://test",conversation:nil)
  precondition(concurrent.items.isEmpty)
  print("PASS: terminal result wins timeout, relaunch recovery, scoped cards, no replay or embedded output")
 }
}
