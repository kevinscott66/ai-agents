import Foundation

func officeTrustedURL(_ url:URL,root:URL)->Bool {
    url.scheme == "https" && url.host == root.host && (url.port ?? 443) == (root.port ?? 443) && url.user == nil && url.password == nil
}

func officeSessionCookie(server:URL,token:String)->HTTPCookie? {
    guard (try? secureServer(server.absoluteString)) != nil,
          token.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil else{return nil}
    // Parsing a Set-Cookie without Domain creates a host-only HttpOnly cookie.
    return HTTPCookie.cookies(withResponseHeaderFields:["Set-Cookie":"__Host-AgentOffice=\(token); Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Strict"],for:server).first
}
