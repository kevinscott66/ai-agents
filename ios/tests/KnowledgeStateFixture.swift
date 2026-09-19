import Foundation
@MainActor enum Credentials { static var token = "one"; static func read(server: String) -> String? { token } }
enum AgentError: Error { case message(String) }
// Модели знаний run.py подставляет из Agent/API.swift вместо маркера ниже — без копий.
// API_MODELS
func proposal(_ id: String) -> KnowledgeProposal {
 KnowledgeProposal(id: id, projectId: "project", conversationId: "dialog", revision: 1, entry: KnowledgeEntry(id: "entry", kind: "fact", text: "Факт", sourceMessageIds: []))
}
func snapshot(_ proposals: [KnowledgeProposal]) -> KnowledgeSnapshot {
 KnowledgeSnapshot(revision: 1, entries: [], project: nil, projectEntries: [], proposals: proposals)
}
@MainActor var writes = 0
@MainActor var writeFails = false
@MainActor var getFails = false
@MainActor var changedIdentityOnRead = false
@MainActor var pending: [KnowledgeProposal] = [proposal("proposal")]
struct AgentAPI {
 let server: String
 @MainActor func knowledge(_ id: String, expectedToken: String) async throws -> KnowledgeSnapshot {
  if getFails { throw URLError(.timedOut) }
  if changedIdentityOnRead { Credentials.token = "two" }
  return snapshot(pending)
 }
 @MainActor func knowledgeProjects(expectedToken: String) async throws -> [KnowledgeProject] { [] }
 @MainActor func assignKnowledgeProject(_ id: String?, conversationID: String, expectedToken: String) async throws -> KnowledgeSnapshot { writes += 1; return snapshot(pending) }
 @MainActor func createKnowledgeProject(title: String, expectedToken: String) async throws -> KnowledgeProject { writes += 1; return KnowledgeProject(id:"project",title:title) }
 @MainActor func editKnowledge(_ entryID: String, scope: String, kind: String?, text: String?, sourceConversationID: String? = nil, conversationID: String, expectedToken: String) async throws -> KnowledgeSnapshot { writes += 1; return snapshot(pending) }
 @MainActor func proposeKnowledge(_ id: String, conversationID: String, expectedToken: String) async throws { writes += 1 }
 @MainActor func decideKnowledge(_ id: String, accept: Bool, expectedToken: String) async throws {
  writes += 1; pending = []
  if writeFails { throw URLError(.timedOut) }
 }
}
// MODEL
@main struct Check {
 @MainActor static func main() async {
  let model = KnowledgeModel(server:"https://fixture.example",conversationID:"dialog")
  await model.refresh()
  precondition(model.snapshot?.proposals.count == 1)
  writeFails = true
  await model.decide(proposal("proposal"), accept:true)
  precondition(writes == 1 && model.needsRefresh)
  await model.decide(proposal("proposal"), accept:true)
  precondition(writes == 1, "Uncertain write was repeated")
  await model.refresh()
  precondition(writes == 1 && !model.needsRefresh && model.snapshot?.proposals.isEmpty == true)
  getFails = true
  await model.assign("project")
  precondition(writes == 2 && model.needsRefresh, "Successful write with failed GET must require reconciliation")
  await model.assign("project")
  precondition(writes == 2)
  getFails = false
  await model.refresh()
  Credentials.token = "two"
  await model.refresh()
  precondition(model.snapshot == nil && model.projects.isEmpty, "Old cached identity remained visible")
  Credentials.token = "one"
  changedIdentityOnRead = true
  let changed = KnowledgeModel(server:"https://fixture.example",conversationID:"dialog")
  await changed.refresh()
  precondition(changed.snapshot == nil && changed.error != nil, "Old identity leaked snapshot")
  await changed.createProject("Forbidden")
  precondition(writes == 2, "Changed identity submitted mutation")
  print("PASS: knowledge uncertainty GET recovery, no mutation retries and account isolation")
 }
}
