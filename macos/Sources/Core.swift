import Foundation

enum AppConfiguration { static var server: String { Bundle.main.object(forInfoDictionaryKey:"AgentServerURL") as? String ?? "" } }

struct Macro: Codable, Identifiable, Equatable {
    var id = UUID()
    var name: String
    var phrase: String
    var steps: [MacroStep]
    var voiceEnabled: Bool? = nil
}
struct MacroStep: Codable, Identifiable, Equatable {
    var id = UUID()
    var kind: Kind = .application
    var value = ""
    var target: String? = nil
    enum Kind: String, Codable, CaseIterable {
        case application, website, volume, pause, speech, shortcut, click
        var label: String {
            switch self {
            case .application: return "Открыть приложение"
            case .website: return "Открыть сайт"
            case .volume: return "Громкость, %"
            case .pause: return "Пауза, секунды"
            case .speech: return "Произнести"
            case .shortcut: return "Комбинация клавиш"
            case .click: return "Щелчок мыши"
            }
        }
    }
}
enum DesktopError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
func secureServer(_ text: String) throws -> URL {
    guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
          url.scheme == "https", let host = url.host, !host.isEmpty,
          url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
          url.path.isEmpty || url.path == "/" else {
        throw DesktopError.message("Укажите HTTPS-адрес сервера без пути и пароля")
    }
    return url
}
func validate(_ macro: Macro) throws {
    guard !macro.name.trimmingCharacters(in: .whitespaces).isEmpty, macro.name.count <= 128, macro.phrase.count <= 160, !macro.steps.isEmpty, macro.steps.count <= 20 else {
        throw DesktopError.message("Нужно название и от 1 до 20 шагов")
    }
    for step in macro.steps {
        switch step.kind {
        case .website:
            guard let u = URL(string: step.value), ["https", "http"].contains(u.scheme ?? ""), u.host != nil, u.user == nil, u.password == nil else { throw DesktopError.message("Некорректный адрес сайта") }
        case .volume: guard let n = Int(step.value), (0...100).contains(n) else { throw DesktopError.message("Громкость: от 0 до 100") }
        case .pause: guard let n = Double(step.value), n.isFinite, (0...30).contains(n) else { throw DesktopError.message("Пауза: от 0 до 30 секунд") }
        case .shortcut: _ = try keySpec(step.value); try validateTarget(step.target)
        case .click: _ = try pointSpec(step.value); try validateTarget(step.target)
        case .application: try validateTarget(step.value)
        case .speech: guard !step.value.isEmpty, step.value.count <= 2000 else { throw DesktopError.message("Заполните значение шага") }
        }
    }
}
struct ChatLine: Codable, Identifiable { var id = UUID(); var role: String; var text: String }
struct RemoteTurn: Decodable { let id: String; let status: String; let replies: [String] }
final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
struct HTTPFailure: LocalizedError {
    let status: Int
    var errorDescription: String? { status == 401 ? "Подключите Mac заново: сессия недействительна" : "Сервер вернул ошибку \(status). Запрос автоматически не повторяется." }
}
struct AgentService {
    let server: URL
    let token: String
    func call(_ path: String, body: [String: String]? = nil, encodedBody:Data? = nil) async throws -> Data {
        var request = URLRequest(url: server.appendingPathComponent("api/native/" + path))
        request.timeoutInterval = 30
        if !token.isEmpty { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        if body != nil || encodedBody != nil { request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try encodedBody ?? JSONEncoder().encode(body!) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        let session = URLSession(configuration: configuration, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode), data.count < 4_000_000 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw HTTPFailure(status: status)
        }
        return data
    }
}

func validateTarget(_ value: String?) throws {
    guard let value, value.range(of: "^[A-Za-z0-9][A-Za-z0-9.-]{2,200}$", options: .regularExpression) != nil else { throw DesktopError.message("Выберите приложение для действия") }
}
struct MacroProposal: Decodable {
    let name: String
    let phrase: String
    let steps: [Step]
    struct Step: Decodable { let kind: MacroStep.Kind; let value: String; let target: String? }
    static func parse(_ text: String) throws -> Macro {
        guard text.utf8.count <= 32000 else { throw DesktopError.message("Сценарий слишком большой") }
        var json = text.trimmingCharacters(in:.whitespacesAndNewlines)
        if json.hasPrefix("```"), let first = json.firstIndex(of:"\n"), let last = json.range(of:"```",options:.backwards), last.lowerBound > first { json = String(json[json.index(after:first)..<last.lowerBound]) }
        let p = try JSONDecoder().decode(Self.self,from:Data(json.utf8))
        let macro = Macro(name:p.name,phrase:p.phrase,steps:p.steps.map{MacroStep(kind:$0.kind,value:$0.value,target:$0.target)})
        try validate(macro); return macro
    }
}
