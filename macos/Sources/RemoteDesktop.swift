import SwiftUI
import ScreenCaptureKit
import ApplicationServices

private struct RemoteReply: Decodable {
    struct Session: Decodable { let id: String; let status: String; let viewer: String }
    var host: String?; var epoch: String?; var session: Session?; var commands: [RemoteCommand]?; var frameID: Int?
}
struct RemoteCommand: Decodable {
    let id: String; let at: Double; let kind: String; let frameID: Int
    var x: Double?; var y: Double?; var endX: Double?; var endY: Double?
    var delta: Double?; var keycode: Int?; var modifiers: UInt64?; var text: String?
}
@MainActor final class RemoteDesktop: ObservableObject {
    @Published var enabled = false
    @Published var status = "Удалённый доступ выключен"
    @Published var pending = ""
    @Published var active = false
    @Published var allowControl = false
    @Published var autoAccept = false
    @Published var displays: [SCDisplay] = []
    @Published var displayID: UInt32 = CGMainDisplayID()
    private var task: Task<Void,Never>?
    private var generation = UUID()
    private var service: AgentService?
    private var boundServer="",boundToken="",epoch=""
    private var currentSession = ""
    private var frameBounds: [Int:(CGRect,Date)] = [:]
    private var seen = Set<String>()
    private var observer: NSObjectProtocol?
    init() {
        observer = NSWorkspace.shared.notificationCenter.addObserver(forName:NSWorkspace.willSleepNotification,object:nil,queue:.main) { [weak self] _ in Task { @MainActor in self?.stop() } }
    }
    func start(server: String) {
        guard !enabled else { return }
        do {
            let token = Vault.read(server)
            guard !token.isEmpty else { throw DesktopError.message("Сначала подключите Mac") }
            guard CGPreflightScreenCaptureAccess() else {
                CGRequestScreenCaptureAccess()
                throw DesktopError.message("Разрешите запись экрана для Агента в настройках macOS, затем включите доступ снова")
            }
            if allowControl && !AXIsProcessTrusted() { throw DesktopError.message("Для управления разрешите Универсальный доступ для Агента") }
            let api = AgentService(server:try secureServer(server),token:token)
            service = api;boundServer=server;boundToken=token;epoch=""; generation = UUID(); let run = generation
            enabled = true; status = "Подключаем Mac…"
            task = Task { [weak self] in
                guard let self else { return }
                do {
                    let content = try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:true)
                    try self.check(run)
                    self.displays = content.displays
                    guard !content.displays.isEmpty else { throw DesktopError.message("Нет доступного экрана") }
                    if !content.displays.contains(where:{$0.displayID == self.displayID}) { self.displayID = content.displays[0].displayID }
                    let registration=try JSONDecoder().decode(RemoteReply.self,from:await api.call("remote/host",encodedBody:JSONSerialization.data(withJSONObject:["name":Host.current().localizedName ?? "Mac","control":self.allowControl])))
                    try self.check(run);self.epoch=registration.epoch ?? ""
                    try self.check(run); self.status = "Mac доступен вашим подключённым устройствам"
                    while !Task.isCancelled {
                        guard Vault.read(server) == token else { throw DesktopError.message("Подключение изменилось") }
                        let reply = try JSONDecoder().decode(RemoteReply.self,from:await api.call("remote/host/poll"))
                        try self.check(run)
                        if let session = reply.session {
                            if self.currentSession != session.id { self.frameBounds.removeAll();self.seen.removeAll();self.currentSession=session.id }
                            self.pending = session.status == "pending" ? session.id : ""
                            self.active = session.status == "active"
                            self.status = self.active ? (self.allowControl ? "Экран передаётся • управление разрешено" : "Экран передаётся • только просмотр") : "Ваше устройство запрашивает экран Mac"
                            if session.status == "pending" && self.autoAccept { try await self.acceptRequest(api,session:session.id,run:run) }
                            if self.active {
                                guard !self.isLocked else { throw DesktopError.message("Mac заблокирован. Сеанс остановлен") }
                                for command in reply.commands ?? [] {
                                    try self.check(run)
                                    if self.allowControl { try self.perform(command) }
                                }
                                try await self.capture(api,session:session.id,run:run)
                            }
                        } else { self.pending="";self.active=false;self.currentSession="";self.frameBounds.removeAll();self.status="Mac доступен вашим подключённым устройствам" }
                        try await Task.sleep(for:.milliseconds(500))
                    }
                } catch {
                    if self.generation == run { let message = error is CancellationError ? "Сеанс остановлен" : error.localizedDescription; self.stop(); self.status=message }
                }
            }
        } catch { status = error.localizedDescription }
    }
    private var isLocked: Bool {
        guard let session=CGSessionCopyCurrentDictionary() as? [String:Any],session[kCGSessionOnConsoleKey as String] as? Bool == true,session[kCGSessionLoginDoneKey as String] as? Bool == true else{return true}
        return session["CGSSessionScreenIsLocked"] as? Bool ?? false
    }
    private func check(_ run:UUID) throws { guard generation == run && enabled && !Task.isCancelled && Vault.read(boundServer)==boundToken else { throw CancellationError() } }
    func stop() {
        generation=UUID(); task?.cancel();task=nil;enabled=false;active=false;pending="";currentSession="";frameBounds.removeAll();seen.removeAll();status="Удалённый доступ выключен"
        let oldEpoch=epoch;epoch=""
        if let api=service,!oldEpoch.isEmpty { Task { _ = try? await api.call("remote/host/stop",body:["epoch":oldEpoch]) } };service=nil
    }
    func accept() {
        guard let api=service,!pending.isEmpty else{return};let session=pending,run=generation
        Task { do { try await acceptRequest(api,session:session,run:run) } catch { if generation==run { status=error.localizedDescription } } }
    }
    private func acceptRequest(_ api:AgentService,session:String,run:UUID) async throws {
        _ = try await api.call("remote/host/accept",body:["session":session]);try check(run);pending=""
    }
    private func capture(_ api:AgentService,session:String,run:UUID) async throws {
        guard let display=displays.first(where:{$0.displayID==displayID}) else { throw DesktopError.message("Экран отключён") }
        let bounds=CGDisplayBounds(displayID)
        guard bounds.width>0 && bounds.height>0 else { throw DesktopError.message("Экран недоступен") }
        let config=SCStreamConfiguration();let scale=min(1,1440.0/Double(max(display.width,display.height)));config.width=max(1,Int(Double(display.width)*scale));config.height=max(1,Int(Double(display.height)*scale));config.showsCursor=true
        let filter=SCContentFilter(display:display,excludingApplications:[],exceptingWindows:[])
        let image=try await SCScreenshotManager.captureImage(contentFilter:filter,configuration:config)
        try check(run)
        guard !isLocked,bounds==CGDisplayBounds(displayID) else { throw DesktopError.message("Экран изменился или Mac заблокирован") }
        let bitmap=NSBitmapImageRep(cgImage:image)
        guard let jpg=bitmap.representation(using:.jpeg,properties:[.compressionFactor:0.5]),jpg.count<=750_000 else { throw DesktopError.message("Кадр слишком большой. Выберите экран меньшего размера") }
        let reply=try JSONDecoder().decode(RemoteReply.self,from:await api.call("remote/host/frame",body:["session":session,"frame":jpg.base64EncodedString()]))
        try check(run)
        if let id=reply.frameID { frameBounds=frameBounds.filter{Date().timeIntervalSince($0.value.1)<4};frameBounds[id]=(bounds,Date()) }
    }
    private func perform(_ c:RemoteCommand) throws {
        guard AXIsProcessTrusted(),!isLocked,!seen.contains(c.id),let (bounds,date)=frameBounds[c.frameID],Date().timeIntervalSince(date)<4,abs(Date().timeIntervalSince1970*1000-c.at)<5000 else { return }
        guard bounds==CGDisplayBounds(displayID) else {throw DesktopError.message("Геометрия экрана изменилась. Подключитесь снова")}
        // No replay: consume locally before posting the first event.
        seen.insert(c.id); if seen.count>1000 { throw DesktopError.message("Лимит сеанса достигнут. Подключитесь снова") }
        func point(_ x:Double?,_ y:Double?) throws -> CGPoint { guard let x,let y,x.isFinite,y.isFinite,(0...1).contains(x),(0...1).contains(y) else {throw DesktopError.message("Некорректные координаты")};return CGPoint(x:bounds.minX+x*(bounds.width-1),y:bounds.minY+y*(bounds.height-1)) }
        let flags=CGEventFlags(rawValue:(c.modifiers ?? 0)&0x1e0000)
        func mouse(_ type:CGEventType,_ p:CGPoint,_ button:CGMouseButton = .left) { let e=CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:p,mouseButton:button);e?.flags=flags;e?.post(tap:.cghidEventTap) }
        switch c.kind {
        case "click","rightClick","doubleClick":
            let p=try point(c.x,c.y),right=c.kind=="rightClick";mouse(right ? .rightMouseDown:.leftMouseDown,p,right ? .right:.left);mouse(right ? .rightMouseUp:.leftMouseUp,p,right ? .right:.left)
            if c.kind=="doubleClick" { for type:CGEventType in [.leftMouseDown,.leftMouseUp] { let e=CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:p,mouseButton:.left);e?.setIntegerValueField(.mouseEventClickState,value:2);e?.post(tap:.cghidEventTap) } }
        case "drag":
            let p=try point(c.x,c.y),end=try point(c.endX,c.endY);mouse(.leftMouseDown,p)
            for i in 1...12 { mouse(.leftMouseDragged,CGPoint(x:p.x+(end.x-p.x)*Double(i)/12,y:p.y+(end.y-p.y)*Double(i)/12)) };mouse(.leftMouseUp,end)
        case "scroll":
            guard let d=c.delta,d.isFinite,abs(d)<=1000 else{return};let p=try point(c.x,c.y);mouse(.mouseMoved,p);CGEvent(scrollWheelEvent2Source:nil,units:.pixel,wheelCount:1,wheel1:Int32(d),wheel2:0,wheel3:0)?.post(tap:.cghidEventTap)
        case "key":
            guard let key=c.keycode,(0...126).contains(key) else{return};let down=CGEvent(keyboardEventSource:nil,virtualKey:CGKeyCode(key),keyDown:true),up=CGEvent(keyboardEventSource:nil,virtualKey:CGKeyCode(key),keyDown:false);down?.flags=flags;up?.flags=flags;down?.post(tap:.cghidEventTap);up?.post(tap:.cghidEventTap)
        case "text":
            guard let text=c.text,text.utf16.count<=1000 else{return};let units=Array(text.utf16)
            for start in stride(from:0,to:units.count,by:20) { let part=Array(units[start..<min(start+20,units.count)]);let down=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:true),up=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:false);part.withUnsafeBufferPointer { if let p=$0.baseAddress {down?.keyboardSetUnicodeString(stringLength:part.count,unicodeString:p);up?.keyboardSetUnicodeString(stringLength:part.count,unicodeString:p)} };down?.post(tap:.cghidEventTap);up?.post(tap:.cghidEventTap) }
        default:break
        }
    }
}
struct RemoteDesktopView:View {
    @EnvironmentObject var remote:RemoteDesktop
    @EnvironmentObject var model:DesktopModel
    var body:some View {
        Form {
            Section("Экран Mac") {
                Label(remote.status,systemImage:remote.active ? "record.circle.fill":"desktopcomputer").foregroundStyle(remote.active ? .red:.primary)
                Text("Смотрите экран и управляйте этим Mac из «Агента» на iPhone. Mac должен быть включён, разблокирован и подключён к сети.")
                Toggle("Разрешить мышь и клавиатуру",isOn:$remote.allowControl).disabled(remote.enabled)
                Toggle("Принимать ваши устройства без подтверждения на Mac",isOn:$remote.autoAccept).disabled(remote.enabled)
                Text("Доступ получают устройства, подключённые к вашему аккаунту. Экран передаётся через ваш сервер; запись не сохраняется. Доступ выключен после запуска приложения.").font(.caption).foregroundStyle(.secondary)
                if !remote.displays.isEmpty { Picker("Экран",selection:$remote.displayID){ForEach(remote.displays,id:\.displayID){Text("Экран \($0.displayID) • \($0.width)×\($0.height)").tag($0.displayID)}}.disabled(remote.enabled) }
                if remote.enabled { Button("Остановить удалённый доступ",role:.destructive){remote.stop()} } else { Button("Включить удалённый доступ"){remote.start(server:model.data.server)}.disabled(!model.connected) }
                if !remote.pending.isEmpty { Button("Разрешить этот сеанс"){remote.accept()}.buttonStyle(.borderedProminent);Button("Отклонить и выключить доступ",role:.destructive){remote.stop()} }
            }
            Section("Разрешения macOS") {
                Button("Запись экрана"){NSWorkspace.shared.open(URL(string:"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)}
                Button("Универсальный доступ"){NSWorkspace.shared.open(URL(string:"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)}
            }
        }.formStyle(.grouped)
    }
}
