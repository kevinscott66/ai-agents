import Foundation
// Модели ответа run.py подставляет из Agent/API.swift вместо маркера ниже — без копий.
// API_MODELS
struct Turn { let id: String; let status: String; let replies: [String]; var replyDetails: [NativeReplyDetail]? = nil; var outputMedia: [NativeOutputMedia]? = nil; var generations: [NativeGeneration]? = nil }
@MainActor var continuations: [CheckedContinuation<Turn, Error>] = []
@MainActor var polledServers: [String] = []

struct TurnRejected: Error { let message: String }
enum AgentError: Error { case message(String) }
@MainActor enum Credentials { static var token = "fixture"; static func read(server: String) -> String? { token } }
@MainActor var uploadFails = false
@MainActor var sentMedia: [String] = []
@MainActor var sentRole: String?
@MainActor var authoritativeRole: String?
@MainActor var sentLocation: SharedLocation?
@MainActor var pollResult: Turn?
@MainActor var remoteRunning = false
@MainActor var archive: [ConversationMessage] = []
@MainActor var conversationList: [ConversationRecord] = []
@MainActor var archivedList: [ConversationRecord] = []
@MainActor var edits: [(String, String?, Bool?)] = []
@MainActor var deleted: [String] = []
struct AgentAPI {
 let server: String
 // API_TITLE
 @MainActor func conversations(cursor: String? = nil, archived: Bool = false, expectedToken: String? = nil) async throws -> ConversationIndex {
  let offset = Int(cursor ?? "0") ?? 0
  let source = archived ? archivedList : conversationList
  let page = Array(source.dropFirst(offset).prefix(200))
  let more = source.count > offset + page.count
  return ConversationIndex(conversations:page,running:remoteRunning,nextCursor:more ? String(offset + page.count) : nil,more:more)
 }
 @MainActor func createConversation(_ id: String, title: String, expectedToken: String? = nil) async throws -> ConversationRecord { ConversationRecord(id: id, title: title, updated: 0, agentKey: authoritativeRole) }
 // Как сервер: архивация переносит диалог между списками, удаление убирает из обоих.
 @MainActor func editConversation(_ id: String, title: String? = nil, archived: Bool? = nil, expectedToken: String? = nil) async throws {
  edits.append((id, title, archived))
  if let title { let name = Self.conversationTitle(title.trimmingCharacters(in: .whitespacesAndNewlines)); conversationList = conversationList.map { $0.id == id ? ConversationRecord(id: $0.id, title: name, updated: $0.updated) : $0 } }
  if archived == true, let row = conversationList.first(where: { $0.id == id }) { conversationList.removeAll { $0.id == id }; archivedList.insert(ConversationRecord(id: row.id, title: row.title, updated: row.updated, archived: 1), at: 0) }
  if archived == false, let row = archivedList.first(where: { $0.id == id }) { archivedList.removeAll { $0.id == id }; conversationList.insert(ConversationRecord(id: row.id, title: row.title, updated: row.updated), at: 0) }
 }
 @MainActor func deleteConversation(_ id: String, expectedToken: String? = nil) async throws { deleted.append(id); conversationList.removeAll { $0.id == id }; archivedList.removeAll { $0.id == id } }
 @MainActor func history(_ id: String, before: Int? = nil, expectedToken: String? = nil) async throws -> ConversationHistory {
  let rows = archive.filter { $0.seq < (before ?? Int.max) }
  return ConversationHistory(messages: Array(rows.suffix(100)), more: rows.count > 100, running: remoteRunning)
 }
 @MainActor func send(_ text: String, id: String, conversationId: String? = nil, expectedToken: String? = nil, attachmentIds: [String] = [], location: SharedLocation? = nil, agentKey: String? = nil) async throws -> Turn {
  sentRole = agentKey; sentMedia = attachmentIds; sentLocation = location
  return try await withCheckedThrowingContinuation { continuations.append($0) }
 }
 @MainActor func upload(_ item: AttachmentDraft, expectedToken: String) async throws -> NativeAttachment { if uploadFails { throw URLError(.cannotConnectToHost) }; return item.metadata }
 @MainActor func poll(_ id: String, expectedToken: String? = nil) async throws -> Turn {
  polledServers.append(server)
  return pollResult ?? Turn(id: id, status: "done", replies: [])
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
  authoritativeRole = "backend"
  model.draft = String(repeating: "😀", count: 4_000); precondition(model.send(server: "https://one.example"))
  while continuations.count < 1 { await Task.yield() }
  precondition(sentRole == "backend", "Must send authoritative role from server, not default Lead")
  authoritativeRole = nil
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
  let mediaModel = ChatModel()
  let file = AttachmentDraft(id:"fixture-attachment",name:"photo.jpg",mimeType:"image/jpeg",data:Data([1,2,3]))
  mediaModel.attachments = [file]
  mediaModel.location = SharedLocation(latitude:55.7,longitude:37.6)
  let position = continuations.count
  precondition(mediaModel.send(server:"https://media.example"))
  while continuations.count <= position { await Task.yield() }
  precondition(sentMedia == [file.id] && sentLocation?.latitude == 55.7)
  precondition(mediaModel.lines.first?.attachments?.first?.id == file.id && mediaModel.attachments.isEmpty)
  continuations[position].resume(returning: Turn(id:"media-turn",status:"done",replies:["Первая часть","Вторая часть"]))
  while mediaModel.busy { await Task.yield() }
  precondition(mediaModel.newReplyForSpeech?.text == "Первая часть\n\nВторая часть")
  let failed = ChatModel(); failed.attachments = [file]; failed.location = SharedLocation(latitude:0,longitude:0)
  uploadFails = true
  precondition(failed.send(server:"https://upload-failure.example"))
  while failed.busy { await Task.yield() }
  precondition(!failed.pending && failed.attachments.count == 1 && failed.location?.latitude == 0 && failed.lines.isEmpty)
  uploadFails = false
  let output = NativeOutputMedia(messageId: "recover:reply:1", attachments: [file.metadata])
  let job = NativeGeneration(id: UUID().uuidString, state: "completed", started: 1, ended: 2)
  UserDefaults.standard.set("recover", forKey: "pendingTurn")
  UserDefaults.standard.set("https://recover.example", forKey: "pendingServer")
  pollResult = Turn(id: "recover", status: "done", replies: [""], outputMedia: [output], generations: [job])
  let recovery = ChatModel(); recovery.resume()
  while recovery.busy { await Task.yield() }
  precondition(recovery.lines.count == 1 && recovery.lines.first?.attachments?.first?.id == file.id)
  precondition(recovery.generations == [job] && recovery.newReplyForSpeech == nil)
  UserDefaults.standard.set("recover", forKey: "pendingTurn")
  UserDefaults.standard.set("https://recover.example", forKey: "pendingServer")
  pollResult = Turn(id: "recover", status: "done", replies: ["Сохранённый результат"], outputMedia: [output], generations: [job])
  recovery.resume()
  while recovery.busy { await Task.yield() }
  precondition(recovery.lines.count == 1 && recovery.generations.count == 1, "Repeated poll duplicated media")
  precondition(recovery.newReplyForSpeech == nil, "Recovered caption replayed speech")
  pollResult = nil
  archive = [ConversationMessage(seq:1,id:"discussion:reply:1",role:"assistant",text:"QA review",agentKey:"qa")]
  await model.selectConversation(conversationList[0].id, server:"https://catalog.example")
  precondition(model.lines.first?.agentKey == "qa", "History lost role attribution")
  UserDefaults.standard.set("recover", forKey: "pendingTurn")
  UserDefaults.standard.set("https://recover.example", forKey: "pendingServer")
  pollResult = Turn(id: "recover", status: "done", replies: ["Reviewed"], replyDetails: [NativeReplyDetail(messageId:"recover:reply:1",agentKey:"qa")], outputMedia: [output])
  recovery.resume()
  while recovery.busy { await Task.yield() }
  precondition(recovery.lines.count == 1 && recovery.lines.first?.agentKey == "qa", "Poll lost role or duplicated reply")
  let saved = try! JSONEncoder().encode(recovery.lines)
  precondition(try! JSONDecoder().decode([ChatLine].self, from: saved).first?.attachments == [file.metadata])
  conversationList = (1...3).map { ConversationRecord(id:String(format:"keep-%016d",$0),title:String($0),updated:Double(10-$0)) }
  archivedList = (1...250).map { ConversationRecord(id:String(format:"arch-%016d",$0),title:String($0),updated:Double(300-$0),archived:1) }
  let shelf = ChatModel()
  await shelf.synchronize(server:"https://archive.example")
  precondition(shelf.conversations.count == 3)
  await shelf.loadArchived(server:"https://archive.example")
  precondition(shelf.archiveLoaded && shelf.archived.count == 200 && shelf.moreArchived, "Archive first page")
  await shelf.loadArchived(server:"https://archive.example", more:true)
  precondition(shelf.archived.count == 250 && !shelf.moreArchived, "Archive did not page past 200")
  let moved = shelf.conversations[1].id
  await shelf.editConversation(moved, archived:true, server:"https://archive.example")
  precondition(edits.last?.0 == moved && edits.last?.2 == true && !shelf.conversations.contains { $0.id == moved }, "Archived dialog stayed in the list")
  await shelf.editConversation(moved, archived:false, server:"https://archive.example")
  precondition(!shelf.archived.contains { $0.id == moved } && shelf.conversations.contains { $0.id == moved }, "Restored dialog stayed archived")
  await shelf.editConversation(moved, title:"  " + String(repeating:"я", count:120), server:"https://archive.example")
  precondition(shelf.conversations.first { $0.id == moved }?.title.utf16.count == 100, "Rename skipped title bound")
  await shelf.deleteConversation(moved, server:"https://archive.example")
  precondition(deleted == [moved] && !shelf.conversations.contains { $0.id == moved } && shelf.historyError == nil, "Deleted dialog remained")
  print("PASS: archive paging past 200, archive/restore, bounded rename and delete")
  print("PASS: media-only recovered output, stable poll IDs, generation reconciliation and no recovery speech")
  print("PASS: media-only send, upload-failure restoration, location and complete speech batch")
  print("PASS: synchronized history, pagination, restoration and cross-server isolation")
  print("PASS: stale cancellation isolation and pending-server recovery")
 }
}
