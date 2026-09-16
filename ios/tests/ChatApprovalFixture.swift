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
  for flag in [true, false] {
   let data = try! JSONSerialization.data(withJSONObject: ["id":"test", "chat_id":1, "requested_by":"lead", "action_type":"MAC_RUN_CLAUDE", "status":"pending", "payload":["provider":"claude", "allowFallback":flag, "_private":"secret"]])
   let item = try! JSONDecoder().decode(ChatApproval.self, from: data)
   precondition(item.details.contains("Первый исполнитель: claude"))
   precondition(item.details.contains(flag ? "до запуска" : "не разрешён"))
   precondition(!item.details.contains("secret"))
  }
  let dialog="native-dialog-0001"
  let model = ChatApprovals(); await model.refresh(server:"https://test",conversation:dialog)
  precondition(model.items.count == 1 && model.visibleItems.count == 1)
  await model.decide(model.items[0], approve:true, server:"https://wrong")
  precondition(Fixture.posts == 0)
  await model.refresh(server:"https://test",conversation:dialog)
  await model.decide(model.items[0], approve:true, server:"https://test")
  await model.decide(model.items[0], approve:true, server:"https://test")
  precondition(Fixture.posts == 1 && !model.outcomes["approval-1"]!.contains("Тест"))
  precondition(model.visibleItems.isEmpty, "Accepted confirmation disappears without deleting tracked approval")
  Fixture.status = "pending"; Fixture.fail = true; Fixture.hold = true
  let concurrent = ChatApprovals(); await concurrent.refresh(server:"https://test",conversation:dialog)
  let task = Task { await concurrent.decide(concurrent.items[0],approve:true,server:"https://test") }
  while Fixture.suspended == nil { await Task.yield() }
  precondition(concurrent.visibleItems.count == 1, "Unacknowledged POST must keep recovery card")
  Fixture.status = "approved"; Fixture.execution = "completed"
  await concurrent.refresh(server:"https://test",conversation:dialog)
  precondition(concurrent.visibleItems.isEmpty)
  let completed = concurrent.outcomes["approval-1"]
  Fixture.suspended?.resume(); Fixture.suspended = nil
  await task.value
  precondition(concurrent.outcomes["approval-1"] == completed && completed!.contains("Выполнено"))
  let relaunched = ChatApprovals(); await relaunched.refresh(server:"https://test",conversation:dialog)
  precondition(relaunched.items.count == 1 && relaunched.outcomes["approval-1"] == completed)
  precondition(relaunched.visibleItems.isEmpty, "Accepted cards stay hidden after relaunch")
  Fixture.execution = nil
  let running = ChatApprovals(); await running.refresh(server:"https://test",conversation:dialog)
  precondition(running.visibleItems.isEmpty, "Server accepted but still running confirmation disappears")
  Fixture.execution = "failed"
  await running.refresh(server:"https://test",conversation:dialog)
  precondition(running.visibleItems.count == 1, "Failure must remain recoverable")
  Fixture.execution = "interrupted"
  let interrupted = ChatApprovals(); await interrupted.refresh(server:"https://test",conversation:dialog)
  precondition(interrupted.visibleItems.count == 1)
  precondition(interrupted.outcomes["approval-1"]!.contains("неизвестен") && !interrupted.outcomes["approval-1"]!.contains("Ожидаем"))
  await interrupted.decide(interrupted.items[0],approve:true,server:"https://test")
  precondition(Fixture.posts == 2, "Interrupted execution must never replay")
  let card = relaunched.items[0]; Fixture.token = "different-account"
  await relaunched.decide(card,approve:true,server:"https://test")
  precondition(Fixture.posts == 2 && relaunched.items.isEmpty)
  await concurrent.refresh(server:"https://test",conversation:nil)
  precondition(concurrent.items.isEmpty)
  Fixture.status = "pending"; Fixture.execution = nil; Fixture.hold = false; Fixture.fail = true
  let uncertain = ChatApprovals(); await uncertain.refresh(server:"https://test",conversation:dialog)
  await uncertain.decide(uncertain.items[0],approve:true,server:"https://test")
  precondition(uncertain.visibleItems.count == 1 && uncertain.outcomes["approval-1"]!.contains("неизвестен"))
  let beforeRefresh = Fixture.posts
  Fixture.status = "approved"
  await uncertain.refresh(server:"https://test",conversation:dialog)
  precondition(uncertain.visibleItems.isEmpty && Fixture.posts == beforeRefresh)
  print("PASS: terminal result wins timeout, relaunch recovery, scoped cards, no replay or embedded output")
 }
}
