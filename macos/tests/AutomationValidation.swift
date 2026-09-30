import Foundation
@main struct AutomationValidation {
 @MainActor static func main() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer {try? FileManager.default.removeItem(at:dir)}
    func rejects(_ run:()throws->Void){do{try run();fatalError("Unsafe scenario accepted")}catch{}}
    rejects {try validate(Macro(name:"Unsafe",phrase:"",steps:[.init(kind:.shortcut,value:"save")]))}
    rejects {try validate(Macro(name:"Unsafe",phrase:"",steps:[.init(kind:.application,value:"Safari\" & do shell script")]))}
    rejects {_ = try pointSpec("NaN,2")}
    rejects {_ = try keySpec("12:0")}
    rejects {_ = try keySpec("999:1048576")}
    rejects {_ = try MacroProposal.parse("{\"name\":\"bad\",\"phrase\":\"\",\"steps\":[{\"kind\":\"shell\",\"value\":\"rm -rf /\"}]}")}
    let macro = try MacroProposal.parse("```json\n{\"name\":\"Safe\",\"phrase\":\"test\",\"steps\":[{\"kind\":\"pause\",\"value\":\"0.1\"}]}\n```")
    let runner = Automation(directory:dir)
    runner.run(macro,dryRun:true)
    while runner.running {try await Task.sleep(for:.milliseconds(10))}
    assert(runner.records.count==1 && runner.records[0].result=="Проверено без выполнения")
    let slow = Macro(name:"Cancel",phrase:"",steps:[.init(kind:.pause,value:"20"),.init(kind:.website,value:"https://example.com")])
    runner.run(slow);try await Task.sleep(for:.milliseconds(40));runner.cancel()
    while runner.running {try await Task.sleep(for:.milliseconds(10))}
    assert(runner.records[0].result=="Остановлено" && runner.records[0].completed==0)
    let reloaded = Automation(directory:dir);assert(reloaded.records.count==2)
    let file=dir.appendingPathComponent("actions.json");let attrs=try FileManager.default.attributesOfItem(atPath:file.path)
    assert((attrs[.posixPermissions] as? NSNumber)?.intValue==0o600)
    print("PASS macro validation, JSON proposal, cancellation before external step, private history restart")
 }
}
