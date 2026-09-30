import Foundation
@main struct Validation {
    static func main() throws {
        for bad in ["http://example.com", "https://a:b@example.com", "https://example.com/path", "https://example.com?q=x", "https://example.com#x"] {
            do { _ = try secureServer(bad); fatalError("Unsafe endpoint accepted") } catch {}
        }
        _ = try secureServer("https://agent.example.com:8443")
        for bad in ["javascript:alert(1)", "file:///etc/passwd", "https://user:secret@example.com"] {
            do { try validate(Macro(name:"Test",phrase:"",steps:[MacroStep(kind:.website,value:bad)])); fatalError("Unsafe macro accepted") } catch {}
        }
        do { try validate(Macro(name:"Test",phrase:"",steps:[MacroStep(kind:.pause,value:"nan")])); fatalError("NaN accepted") } catch {}
        print("PASS endpoint and macro validation")
    }
}
