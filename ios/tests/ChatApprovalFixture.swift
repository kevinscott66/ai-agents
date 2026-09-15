import Foundation
@MainActor enum Fixture {
 static let item = #"{"id":"approval-1","chat_id":123456,"requested_by":"lead","action_type":"TEST_ACTION","status":"pending","payload":{"target":"test"}}"#
 static var token = "test"
 static var posts = 0
 static var fail = false
 static var savedDecision: String?
 static var actionOutput = false
}
@MainActor struct Credentials { static func read(server: String) -> String? { Fixture.token } }
struct AgentAPI { let server: String; func ownerID(expectedToken: String? = nil) async throws -> String { "123456" } }
enum AgentError: LocalizedError { case message(String); var errorDescription: String? { if case .message(let s) = self { s } else { nil } } }
@MainActor enum PanelTransport {
 static func request(server: String, path: String, method: String, body: String?, expectedToken: String? = nil) async throws -> [String: Any] {
  if method == "GET", path.hasPrefix("/api/actions") {
   return ["status":200,"body":Fixture.actionOutput ? #"{"actions":[{"chat_id":123456,"status":"ok","result":{"approvalId":"approval-1","output":"Тест"}}]}"# : #"{"actions":[]}"#]
  }
  if method == "GET", let saved = Fixture.savedDecision {
   let body = path.contains("status=" + saved) ? Fixture.item.replacingOccurrences(of:"pending",with:saved) : ""
   return ["status":200,"body":"{\"approvals\":[" + body + "]}"]
  }
  if method == "GET" { return ["status":200,"body":"{\"approvals\":[" + Fixture.item + "]}"] }
  Fixture.posts += 1
  if Fixture.fail { throw AgentError.message("network") }
  return ["status":200,"body":"{\"approval\":" + Fixture.item.replacingOccurrences(of:"pending",with:"approved") + ",\"executed\":true}"]
 }
}
// MODEL
@main struct Test {
 @MainActor static func main() async {
  let model = ChatApprovals(); await model.refresh(server:"https://test")
  precondition(model.items.count == 1)
  await model.decide(model.items[0], approve:true, server:"https://wrong")
  precondition(Fixture.posts == 0)
  await model.refresh(server:"https://test")
  await model.decide(model.items[0], approve:true, server:"https://test")
  await model.decide(model.items[0], approve:true, server:"https://test")
  precondition(Fixture.posts == 1 && model.outcomes["approval-1"]!.contains("завершил"))
  let uncertain = ChatApprovals(); await uncertain.refresh(server:"https://test"); Fixture.fail = true
  await uncertain.decide(uncertain.items[0], approve:true, server:"https://test")
  await uncertain.refresh(server:"https://test")
  await uncertain.decide(uncertain.items[0], approve:true, server:"https://test")
  precondition(Fixture.posts == 2 && uncertain.outcomes["approval-1"]!.contains("неизвестен"))
  Fixture.savedDecision = "approved"
  await uncertain.refresh(server:"https://test")
  precondition(uncertain.outcomes["approval-1"]!.contains("принято сервером") && Fixture.posts == 2)
  Fixture.actionOutput = true
  await uncertain.refresh(server:"https://test")
  precondition(uncertain.outcomes["approval-1"] == "Выполнено.\nТест" && Fixture.posts == 2)
  Fixture.actionOutput = false
  Fixture.savedDecision = "failed"
  await uncertain.refresh(server:"https://test")
  precondition(uncertain.outcomes["approval-1"] == "Выполнено.\nТест" && Fixture.posts == 2)
  Fixture.savedDecision = nil
  let switched = ChatApprovals(); await switched.refresh(server:"https://test")
  let card = switched.items[0]; Fixture.token = "different-account"
  await switched.decide(card, approve:true, server:"https://test")
  precondition(Fixture.posts == 2 && switched.items.isEmpty)
  print("PASS: owner context, single decision, ambiguous failure never retries")
 }
}
