import Foundation
@main struct Test {
 static func main() throws {
  let valid = try PanelTransport.url(server: "https://agent.test:8443", path: "/api/wiki/page?scope=lead&slug=hello%20world")
  precondition(valid.host == "agent.test" && valid.port == 8443 && valid.path == "/api/wiki/page")
  for path in ["https://evil.test/api/tasks", "//evil.test/api/tasks", "/api/native/pair", "/api/tasks/../../metrics", "/api/tasks/%2e%2e/metrics", "/api/tasks#fragment", "/api/tasks/%252e%252e/x", "/api/unknown"] {
   do { _ = try PanelTransport.url(server: "https://agent.test", path: path); fatalError("accepted invalid path: \(path)") } catch {}
  }
  print("PASS: panel route confinement and encoded query preservation")
 }
}
