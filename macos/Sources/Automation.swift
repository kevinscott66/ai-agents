import AppKit
import Combine
import AVFoundation

struct RunRecord: Codable, Identifiable {
    var id = UUID()
    var date = Date()
    var name: String
    var result: String
    var completed: Int
    var total: Int
}
func keySpec(_ value: String) throws -> (CGKeyCode, CGEventFlags) {
    let keys: [String: CGKeyCode] = ["copy":8,"paste":9,"undo":6,"save":1,"space":49,"return":36,"escape":53,"left":123,"right":124,"up":126,"down":125]
    if let code = keys[value] { return (code, ["copy","paste","undo","save"].contains(value) ? .maskCommand : []) }
    let p = value.split(separator: ":")
    guard p.count == 2, let key = UInt16(p[0]), key <= 126, let flags = UInt64(p[1]), flags & ~UInt64(0x1e0000) == 0, flags & UInt64(0x180000) != 0 else { throw DesktopError.message("Разрешены именованные клавиши или записанные сочетания с ⌘ / ⌥") }
    return (key, CGEventFlags(rawValue: flags))
}
func pointSpec(_ value: String) throws -> CGPoint {
    let p = value.split(separator: ",").map { Double($0.trimmingCharacters(in: .whitespaces)) }
    guard p.count == 2, let x = p[0], let y = p[1], x.isFinite, y.isFinite, abs(x) <= 32768, abs(y) <= 32768 else { throw DesktopError.message("Укажите координаты x, y") }
    return CGPoint(x:x, y:y)
}
@MainActor final class Automation: ObservableObject {
    @Published var running = false
    @Published var currentStep = 0
    @Published var name = ""
    @Published var status = "Готов к работе"
    @Published var records: [RunRecord] = []
    @Published var recording = false
    @Published var captured: [MacroStep] = []
    @Published var permissionError = ""
    private var job: Task<Void,Never>?
    private var recordingGeneration = UUID()
    private var monitor: Any?
    private var recordingTimer: Task<Void,Never>?
    private var lastEvent = Date()
    private let historyURL: URL
    private var historyReadable = true
    init(directory: URL? = nil) {
        let dir = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("DobropalmAgent")
        historyURL = dir.appendingPathComponent("actions.json")
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes:[.posixPermissions:0o700])
            if FileManager.default.fileExists(atPath: historyURL.path) { records = try JSONDecoder().decode([RunRecord].self, from: Data(contentsOf: historyURL)) }
        } catch { historyReadable = false; status = "История действий не читается; файл сохранён без изменений" }
    }
    func run(_ macro: Macro, dryRun: Bool = false) {
        guard !running, !recording else { return }
        do { try validate(macro) } catch { status = error.localizedDescription; return }
        running = true; currentStep = 0; name = macro.name; status = dryRun ? "Проверка сценария" : "Выполняется"
        job = Task {
            var result = "Выполнено"
            do {
                for (i,step) in macro.steps.enumerated() {
                    try Task.checkCancellation()
                    status = "\(i+1)/\(macro.steps.count) · \(step.kind.label)"
                    if !dryRun { try await execute(step) }
                    currentStep = i+1
                }
                if dryRun { result = "Проверено без выполнения" }
            } catch is CancellationError { result = "Остановлено" }
            catch { result = error.localizedDescription }
            status = result; running = false
            records.insert(RunRecord(name: macro.name, result: result, completed: currentStep, total: macro.steps.count), at: 0)
            records = Array(records.prefix(300))
            if historyReadable {
                do { try JSONEncoder().encode(records).write(to: historyURL, options: .atomic); try FileManager.default.setAttributes([.posixPermissions:0o600], ofItemAtPath: historyURL.path) }
                catch { status += " · Не удалось сохранить историю" }
            }
            job = nil
        }
    }
    func cancel() { job?.cancel() }
    private func activate(_ bundle: String) async throws {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { throw DesktopError.message("Приложение \(bundle) не установлено") }
        let app = try await NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
        app.activate(options: [.activateAllWindows])
        try await Task.sleep(for: .milliseconds(400))
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundle else { throw DesktopError.message("Не удалось переключиться в целевое приложение") }
    }
    private func execute(_ step: MacroStep) async throws {
        switch step.kind {
        case .application: try await activate(step.value)
        case .website:
            guard NSWorkspace.shared.open(URL(string: step.value)!) else { throw DesktopError.message("Не удалось открыть сайт") }
        case .pause: try await Task.sleep(for: .seconds(Double(step.value)!))
        case .volume:
            let value = Int(step.value)!
            let script = NSAppleScript(source: "set volume output volume \(value)")!
            var failure: NSDictionary?; script.executeAndReturnError(&failure)
            if failure != nil { throw DesktopError.message("macOS отклонила изменение громкости") }
        case .speech:
            let speaker = AVSpeechSynthesizer(); let utterance = AVSpeechUtterance(string: step.value); utterance.voice = AVSpeechSynthesisVoice(language:"ru-RU"); speaker.speak(utterance)
            do { while speaker.isSpeaking { try await Task.sleep(for:.milliseconds(100)) } }
            catch { speaker.stopSpeaking(at:.immediate); throw error }
        case .shortcut, .click:
            guard AXIsProcessTrusted() else { throw DesktopError.message("Разрешите «Агенту» Универсальный доступ в настройках macOS") }
            try await activate(step.target ?? "")
            try Task.checkCancellation()
            if step.kind == .shortcut {
                let (key,flags) = try keySpec(step.value)
                guard let down = CGEvent(keyboardEventSource:nil,virtualKey:key,keyDown:true), let up = CGEvent(keyboardEventSource:nil,virtualKey:key,keyDown:false) else { throw DesktopError.message("Не удалось создать нажатие") }
                down.flags = flags; up.flags = flags; down.post(tap:.cghidEventTap); up.post(tap:.cghidEventTap)
            } else {
                let point = try pointSpec(step.value)
                let displays = NSScreen.screens.compactMap { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value }
                guard displays.contains(where:{ CGDisplayBounds($0).contains(point) }) else { throw DesktopError.message("Координата вне подключённых экранов; перезапишите действие") }
                var hit: AXUIElement?
                guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(),Float(point.x),Float(point.y),&hit) == .success, let element = hit else { throw DesktopError.message("Не удалось проверить элемент под курсором; действие остановлено") }
                var owner: pid_t = 0
                guard AXUIElementGetPid(element,&owner) == .success, let target = NSWorkspace.shared.frontmostApplication, target.bundleIdentifier == step.target, owner == target.processIdentifier else { throw DesktopError.message("В точке щелчка другое приложение. Перезапишите координаты.") }
                CGEvent(mouseEventSource:nil,mouseType:.leftMouseDown,mouseCursorPosition:point,mouseButton:.left)?.post(tap:.cghidEventTap)
                CGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:point,mouseButton:.left)?.post(tap:.cghidEventTap)
            }
        }
    }
    func startRecording() {
        guard !running, !recording else { return }
        guard CGPreflightListenEventAccess() else { _ = CGRequestListenEventAccess(); permissionError = "Разрешите мониторинг ввода в настройках macOS и нажмите запись снова"; return }
        recordingGeneration = UUID(); let ticket = recordingGeneration
        captured = []; permissionError = ""; lastEvent = Date(); recording = true
        monitor = NSEvent.addGlobalMonitorForEvents(matching:[.leftMouseUp,.keyDown]) { [weak self] event in
            Task { @MainActor in
                guard let self, self.recording, self.recordingGeneration == ticket, let target = NSWorkspace.shared.frontmostApplication?.bundleIdentifier, target != Bundle.main.bundleIdentifier else { return }
                var step: MacroStep
                if event.type == .keyDown {
                    let flags = event.modifierFlags.intersection([.command,.option,.control,.shift])
                    guard flags.contains(.command) || flags.contains(.option) else { return }
                    step = MacroStep(kind:.shortcut,value:"\(event.keyCode):\(flags.rawValue)",target:target)
                } else {
                    guard let point = event.cgEvent?.location else { return }
                    step = MacroStep(kind:.click,value:"\(Int(point.x)),\(Int(point.y))",target:target)
                }
                let delay = min(5,Date().timeIntervalSince(self.lastEvent)); self.lastEvent = Date()
                if delay > 0.4 && self.captured.count < 18 { self.captured.append(MacroStep(kind:.pause,value:String(format:"%.1f",delay))) }
                self.captured.append(step)
                if self.captured.count >= 20 { self.stopRecording() }
            }
        }
        if monitor == nil { recording = false; permissionError = "macOS не разрешила запись"; return }
        recordingTimer = Task { try? await Task.sleep(for:.seconds(60)); if !Task.isCancelled { stopRecording() } }
    }
    func stopRecording() { recordingGeneration = UUID(); recording = false; if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil; recordingTimer?.cancel(); recordingTimer = nil }
}
