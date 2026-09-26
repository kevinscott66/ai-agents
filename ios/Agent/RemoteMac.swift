import SwiftUI
import UIKit
import ImageIO

struct RemoteMacHost:Decodable,Identifiable { let id:String;let name:String }
struct RemoteMacHosts:Decodable { let hosts:[RemoteMacHost] }
struct RemoteMacSession:Decodable { let session:String;let status:String;var frame:String?;var frameID:Int?;var control:Bool? }
struct RemoteMacOK:Decodable { var ok:Bool? }
struct RemoteMacInput:Encodable {
    var kind:String;var frameID:Int
    var x:Double?;var y:Double?;var endX:Double?;var endY:Double?;var delta:Double?
    var keycode:Int?;var modifiers:UInt64?;var text:String?
}
@MainActor final class RemoteMacModel:ObservableObject {
    @Published var hosts:[RemoteMacHost]=[]
    @Published var image:UIImage?
    @Published var status="Выберите Mac"
    @Published var session=""
    @Published var ready=false
    @Published var canControl=false
    @Published var busy=false
    @Published var error=""
    private var server="",token=""
    private var generation=UUID()
    private var polling:Task<Void,Never>?
    private var inputTask:Task<Void,Never>?
    private var frameID=0
    private var received=Date.distantPast
    private var sending=false
    func configure(_ server:String) { if self.server != server { stop();self.server=server };token=Credentials.read(server:server) ?? "" }
    private func valid(_ run:UUID) -> Bool { run==generation && Credentials.read(server:server)==token && !Task.isCancelled }
    func refresh() async {
        guard !busy,!token.isEmpty else{return};let run=generation;busy=true;defer{if run==generation{busy=false}}
        do {let result:RemoteMacHosts=try await AgentAPI(server:server).remote("hosts",expectedToken:token);guard valid(run) else{return};hosts=result.hosts;error="";if hosts.isEmpty{status="На Mac откройте «Экран Mac» и включите доступ"}}
        catch {if valid(run){self.error=errorMessage(error)}}
    }
    func connect(_ host:RemoteMacHost) {
        guard !busy,session.isEmpty else{return};let run=generation,boundServer=server,boundToken=token;busy=true;error=""
        polling=Task {
            do {
                guard valid(run) else{return}
                let reply:RemoteMacSession=try await AgentAPI(server:boundServer).remote("request",body:["host":host.id],expectedToken:boundToken)
                guard valid(run) else{Task{let _:RemoteMacOK?=try? await AgentAPI(server:boundServer).remote("session/"+reply.session+"/stop",body:[:],expectedToken:boundToken)};return};session=reply.session;status="Подтвердите сеанс на Mac";busy=false
                while !Task.isCancelled {
                    let state:RemoteMacSession=try await AgentAPI(server:server).remote("session/"+reply.session,expectedToken:token)
                    guard valid(run) else{return}
                    canControl=state.control == true
                    status=state.status=="active" ? "\(host.name) • \(canControl ? "Управление" : "Только просмотр")":"Ожидаем разрешения на Mac"
                    if let frame=state.frame,let id=state.frameID,let data=Data(base64Encoded:frame),data.count<=1_000_000,let decoded=Self.decodeFrame(data) {image=decoded;if frameID != id {frameID=id;received=Date()};ready=Date().timeIntervalSince(received)<3;if !ready {status="Кадр устарел • управление приостановлено"}}
                    try await Task.sleep(for:.milliseconds(500))
                }
            } catch {if valid(run){let message=errorMessage(error);stop();self.error=message}}
        }
    }
    func input(_ value:RemoteMacInput) {
        guard ready,canControl,!sending,!session.isEmpty,Date().timeIntervalSince(received)<3 else{return}
        let run=generation,id=session,boundServer=server,boundToken=token;var input=value;input.frameID=frameID;sending=true
        inputTask=Task {
            defer{if run==generation{sending=false}}
            do {guard valid(run) else{return};let _:RemoteMacOK=try await AgentAPI(server:boundServer).remote("session/"+id+"/input",encodedBody:JSONEncoder().encode(input),expectedToken:boundToken);guard valid(run) else{return};error=""}
            catch {if valid(run){self.error=errorMessage(error)}}
        }
    }
    func stop() {
        let id=session,oldServer=server,oldToken=token
        generation=UUID();inputTask?.cancel();inputTask=nil;polling?.cancel();polling=nil;session="";ready=false;canControl=false;busy=false;sending=false;image=nil;frameID=0;status="Сеанс завершён"
        if !id.isEmpty { Task { let _:RemoteMacOK?=try? await AgentAPI(server:oldServer).remote("session/"+id+"/stop",body:[:],expectedToken:oldToken) } }
    }
    static func decodeFrame(_ data:Data)->UIImage? {
        guard data.count<=1_000_000,let source=CGImageSourceCreateWithData(data as CFData,nil),let props=CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [CFString:Any],let w=props[kCGImagePropertyPixelWidth] as? Int,let h=props[kCGImagePropertyPixelHeight] as? Int,w>0,h>0,w<=4096,h<=4096,w*h<=8_000_000 else{return nil}
        return UIImage(data:data)
    }
    private func errorMessage(_ error:Error)->String { "\(error.localizedDescription). Если Mac недоступен, проверьте, что он включён и удалённый доступ разрешён." }
}
struct RemoteMacView:View {
    let server:String
    @StateObject private var model=RemoteMacModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var text=""
    @State private var mode="click"
    @State private var zoom:CGFloat=1
    @State private var command=false
    @State private var shift=false
    @State private var option=false
    @State private var control=false
    var modifiers:UInt64 { (command ? 0x100000:0)|(shift ? 0x20000:0)|(option ? 0x80000:0)|(control ? 0x40000:0) }
    var body:some View {
        VStack(spacing:12) {
            HStack {Text(model.status).font(.caption);Spacer();if !model.session.isEmpty {Button("Отключиться",role:.destructive){model.stop()}}}.padding(.horizontal)
            if !model.error.isEmpty {Text(model.error).font(.caption).foregroundStyle(.red).padding(.horizontal)}
            if model.session.isEmpty {
                List {
                    Section {ForEach(model.hosts){host in Button {model.connect(host)} label:{Label(host.name,systemImage:"desktopcomputer")}.disabled(model.busy)}}
                    Section {Button("Обновить список"){Task{await model.refresh()}}.disabled(model.busy);Text("На Mac: Агент → Экран Mac → Включить удалённый доступ. Разрешите запись экрана; для мыши и клавиатуры — Универсальный доступ.").font(.footnote)}
                }
            } else {
                if let image=model.image {
                    GeometryReader { geo in
                        let scale=min(geo.size.width/image.size.width,geo.size.height/image.size.height)*zoom
                        let size=CGSize(width:image.size.width*scale,height:image.size.height*scale)
                        ScrollView([.horizontal,.vertical]) {
                        Image(uiImage:image).resizable().frame(width:size.width,height:size.height).contentShape(Rectangle())
                            .gesture(DragGesture(minimumDistance:0).onEnded{value in
                                let start=value.startLocation,end=value.location
                                guard start.x>=0,start.y>=0,start.x<=size.width,start.y<=size.height,end.x>=0,end.y>=0,end.x<=size.width,end.y<=size.height else{return}
                                let x=Double(start.x/size.width),y=Double(start.y/size.height)
                                if mode=="scroll" {model.input(RemoteMacInput(kind:"scroll",frameID:0,x:x,y:y,delta:Double(max(-1000,min(1000,value.translation.height*3))))) }
                                else if mode=="drag" {model.input(RemoteMacInput(kind:"drag",frameID:0,x:x,y:y,endX:Double(end.x/size.width),endY:Double(end.y/size.height),modifiers:modifiers))}
                                else {model.input(RemoteMacInput(kind:mode,frameID:0,x:Double(end.x/size.width),y:Double(end.y/size.height),modifiers:modifiers))}
                            },including:mode=="pan" ? .none:.all)
                            .frame(minWidth:geo.size.width,minHeight:geo.size.height)
                        }
                    }.background(Color.black.opacity(0.94))
                } else {Spacer();ProgressView("Ожидаем экран…");Spacer()}
                VStack(spacing:10) {
                    Picker("Мышь",selection:$mode){Text("Клик").tag("click");Text("2×").tag("doubleClick");Text("Правый").tag("rightClick");Text("Тянуть").tag("drag");Text("Скролл").tag("scroll");Text("Обзор").tag("pan")}.pickerStyle(.menu)
                    HStack {Text("Масштаб");Slider(value:$zoom,in:1...4);Text("\(Int(zoom*100))%").monospacedDigit()}.font(.caption)
                    HStack {Toggle("⌘",isOn:$command);Toggle("⇧",isOn:$shift);Toggle("⌥",isOn:$option);Toggle("⌃",isOn:$control);ForEach([("Esc",53),("Tab",48),("⌫",51),("↵",36)],id:\.1){key in Button(key.0){model.input(RemoteMacInput(kind:"key",frameID:0,keycode:key.1,modifiers:modifiers))}}}.toggleStyle(.button)
                    HStack {TextField("Текст на Mac",text:$text).textFieldStyle(.roundedBorder);Button("Ввести"){let value=text;text="";model.input(RemoteMacInput(kind:"text",frameID:0,text:value))}.disabled(text.isEmpty || text.utf16.count>1000)}
                    HStack {ForEach([("←",123),("↑",126),("↓",125),("→",124),("⌘C",8),("⌘V",9),("⌘A",0)],id:\.1){key in Button(key.0){model.input(RemoteMacInput(kind:"key",frameID:0,keycode:key.1,modifiers:key.0.hasPrefix("⌘") ? 0x100000:modifiers))}}}.buttonStyle(.bordered)
                }.padding(.horizontal).disabled(!model.ready || !model.canControl)
            }
        }.navigationTitle("Экран Mac").navigationBarTitleDisplayMode(.inline)
            .task {model.configure(server);await model.refresh()}
            .onDisappear {model.stop()}
            .onChange(of:scenePhase){_,phase in if phase != .active {model.stop()}}
    }
}
