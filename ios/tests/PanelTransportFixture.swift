import Foundation
@main struct Test {
 static func main() throws {
  for provider in ["claude", "codex"] {
   for enabled in [true, false] {
    let data = try JSONSerialization.data(withJSONObject: ["provider":provider, "project":"app", "prompt":"test", "allowFallback":enabled])
    let payload = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    let launch = try PanelMacLaunch(payload)
    precondition(launch.provider == provider && launch.allowFallback == (enabled && provider == "claude"))
    let draft = PanelMacLaunch.draft(project: launch.project, prompt: launch.prompt, provider: launch.provider, allowFallback: launch.allowFallback)
    precondition(draft.contains("provider=\(provider), allowFallback=\(launch.allowFallback)"))
    precondition(draft.contains(launch.allowFallback ? "до начала выполнения" : "Не заменяй"))
   }
  }
  let legacy = try PanelMacLaunch(["project":"app", "prompt":"test"])
  precondition(!legacy.allowFallback)
  for invalid: Any in ["true", 1, NSNull()] {
   do { _ = try PanelMacLaunch(["project":"app", "prompt":"test", "allowFallback":invalid]); fatalError("invalid fallback accepted") } catch {}
  }
  print("PASS: Mac bridge keeps selected executor, boolean fallback and legacy opt-out")
  let valid = try PanelTransport.url(server: "https://agent.test:8443", path: "/api/wiki/page?scope=lead&slug=hello%20world")
  precondition(valid.host == "agent.test" && valid.port == 8443 && valid.path == "/api/wiki/page")
  for path in ["https://evil.test/api/tasks", "//evil.test/api/tasks", "/api/native/pair", "/api/tasks/../../metrics", "/api/tasks/%2e%2e/metrics", "/api/tasks#fragment", "/api/tasks/%252e%252e/x", "/api/unknown"] {
   do { _ = try PanelTransport.url(server: "https://agent.test", path: path); fatalError("accepted invalid path: \(path)") } catch {}
  }
  print("PASS: panel route confinement and encoded query preservation")
 }
}
