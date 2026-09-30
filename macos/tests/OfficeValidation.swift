import Foundation
@main struct OfficeValidation {
    static func main() throws {
        let root=URL(string:"https://agent.example.test:8443")!
        let token=String(repeating:"a",count:64)
        let cookie=officeSessionCookie(server:root,token:token)!
        assert(cookie.isSecure && cookie.isHTTPOnly)
        assert(cookie.domain=="agent.example.test" && cookie.path=="/")
        assert(cookie.name=="__Host-AgentOffice")
        for bad in ["", "abc",token+"; Domain=evil.test",String(repeating:"z",count:64)] {assert(officeSessionCookie(server:root,token:bad)==nil)}
        assert(officeSessionCookie(server:URL(string:"http://agent.example.test")!,token:token)==nil)
        for bad in ["https://agent.example.test/office/","https://child.agent.example.test:8443/office/","https://agent.example.test.evil.test:8443/", "https://user@agent.example.test:8443/", "http://agent.example.test:8443/"] {assert(!officeTrustedURL(URL(string:bad)!,root:root))}
        assert(officeTrustedURL(root.appendingPathComponent("office/"),root:root))
        print("PASS office cookie flags, credential validation and exact-origin navigation")
    }
}
