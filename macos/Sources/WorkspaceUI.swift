import SwiftUI
import AVFoundation

struct AgentAvatar: View {
    var active:Bool
    var listening:Bool = false
    @AppStorage("animations") private var animations=true
    @AppStorage("accent") private var accent="forest"
    private var color:Color {accent=="blue" ? .blue : accent=="graphite" ? .gray : Color(red:0.32,green:0.41,blue:0.32)}
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        TimelineView(.animation(minimumInterval:1/24,paused:!active || !animations || reduceMotion)) { time in
            let pulse=active && animations && !reduceMotion ? sin(time.date.timeIntervalSinceReferenceDate*3)*0.04 : 0
            ZStack {
                Circle().fill(.tint.opacity(0.08)).scaleEffect(1.2+pulse)
                Circle().stroke(.tint.opacity(0.12),lineWidth:1).scaleEffect(1.35+pulse)
                Circle().fill(LinearGradient(colors:[color.opacity(0.4),color],startPoint:.topLeading,endPoint:.bottomTrailing)).shadow(color:color.opacity(0.22),radius:20,y:10)
                HStack(spacing:22) {
                    Capsule().fill(.white).frame(width:9,height:listening ? 27 : 17)
                    Capsule().fill(.white).frame(width:9,height:listening ? 27 : 17)
                }.offset(y:-3)
                Capsule().fill(.white.opacity(0.75)).frame(width:active ? 22 : 15,height:3).offset(y:25)
            }.padding(22).scaleEffect(1+pulse)
        }.accessibilityLabel(listening ? "Агент слушает" : active ? "Агент работает" : "Агент готов")
    }
}
struct FloatingWindowSetup: NSViewRepresentable {
    func makeNSView(context:Context)->NSView { let v=NSView();DispatchQueue.main.async{v.window?.level = .floating;v.window?.isMovableByWindowBackground=true};return v }
    func updateNSView(_ nsView:NSView,context:Context) {}
}
struct CompanionView: View {
    @EnvironmentObject var model:DesktopModel
    @EnvironmentObject var voice:Voice
    @EnvironmentObject var automation:Automation
    @Environment(\.openWindow) var openWindow
    @AppStorage("avatarOpacity") var opacity=0.94
    var body:some View {
        VStack(spacing:10) {
            AgentAvatar(active:voice.listening || voice.speaking || automation.running || model.busy,listening:voice.listening).frame(width:160,height:160)
            Text(voice.armed ? "Жду обращения" : voice.listening ? "Слушаю" : voice.speaking ? "Говорю" : automation.running ? automation.status : model.busy ? "Лид работает" : "Рядом, когда нужен").font(.callout).lineLimit(2)
            HStack {
                Button { voice.setWake(!voice.armed) } label:{Image(systemName:voice.armed ? "mic.fill" : "mic")}.help("Включить обращение по имени")
                Button("Открыть") { NSApp.activate(ignoringOtherApps:true);openWindow(id:"main") }
                Button { voice.setWake(false);voice.stopSpeaking();automation.cancel() } label:{Image(systemName:"stop.fill")}.help("Остановить голос и локальный сценарий")
            }
        }.padding(18).background(.regularMaterial.opacity(opacity)).background(FloatingWindowSetup()).frame(width:250,height:265)
    }
}
struct Dashboard: View {
    @EnvironmentObject var model:DesktopModel
    @EnvironmentObject var voice:Voice
    @EnvironmentObject var automation:Automation
    @Environment(\.openWindow) var openWindow
    @Binding var section:String
    var body:some View {
        VStack(alignment:.leading,spacing:24) {
                HStack(spacing:35) {
                    VStack(alignment:.leading,spacing:15) {
                        Text("Ваш Mac.\nВаша команда.").font(.system(size:36,weight:.semibold,design:.rounded)).fixedSize(horizontal:false,vertical:true)
                        Text("Голос, привычные действия и Лид —\nв одном рабочем пространстве.").font(.title3).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
                        HStack { Button("Поговорить с Лидом") { section="Чат" }.buttonStyle(.borderedProminent);Button("Мини-помощник") { openWindow(id:"companion") } }
                    }
                    Spacer();AgentAvatar(active:voice.listening || voice.speaking || model.busy || automation.running,listening:voice.listening).frame(width:210,height:210)
                }
                HStack(spacing:14) {
                    metric("Команды",value:"\(model.data.macros.count)",icon:"command")
                    metric("Голос",value:voice.armed ? "Жду обращения" : voice.listening ? "Слушаю" : "Выключен",icon:"waveform")
                    metric("Лид",value:model.busy ? "Работает" : model.connected ? "Ключ сохранён" : "Нужен вход",icon:"network")
                }
                HStack {Text("Быстрые действия").font(.title2.bold());Spacer();Button("Все команды") {section="Команды"} }
                LazyVGrid(columns:[GridItem(.adaptive(minimum:200))],spacing:12) {
                    ForEach(Array((model.data.macros.isEmpty ? CommandPack.all[0].macros : model.data.macros).prefix(6))) { macro in
                        Button { automation.run(macro) } label: {
                            VStack(alignment:.leading,spacing:12) {Image(systemName:"play.circle").font(.title2);Text(macro.name).font(.headline);Text("\(macro.steps.count) действий").font(.caption).foregroundStyle(.secondary)}.frame(maxWidth:.infinity,minHeight:100,alignment:.leading).padding(16)
                        }.buttonStyle(.bordered).disabled(automation.running || automation.recording)
                    }
                }
                HStack {Image(systemName:automation.running ? "gearshape.2" : "checkmark.circle");Text(automation.status).textSelection(.enabled);Spacer();if automation.running {Button("Остановить") {automation.cancel()} } }.padding(16).background(.quaternary.opacity(0.3),in:RoundedRectangle(cornerRadius:12))
                HStack {Text("Последние действия").font(.title2.bold());Spacer();Button("История") {section="История"} }
                if automation.records.isEmpty {Text("Здесь появятся выполненные команды и результаты проверки сценариев.").foregroundStyle(.secondary)}
                ForEach(automation.records.prefix(3)) { record in HStack {VStack(alignment:.leading){Text(record.name);Text(record.result).font(.caption).foregroundStyle(.secondary)};Spacer();Text(record.date,style:.time).font(.caption).foregroundStyle(.secondary)} }
            }.padding(.bottom,20)
    }
    private func metric(_ title:String,value:String,icon:String)->some View { VStack(alignment:.leading,spacing:9){Label(title,systemImage:icon).font(.caption).foregroundStyle(.secondary);Text(value).font(.headline)}.frame(maxWidth:.infinity,alignment:.leading).padding(18).background(.quaternary.opacity(0.25),in:RoundedRectangle(cornerRadius:14)) }
}
struct HistoryView:View {
    @EnvironmentObject var automation:Automation
    var body:some View {
        List(automation.records) { r in
            VStack(alignment:.leading,spacing:8) {
                HStack {Text(r.name).font(.headline);Spacer();Text(r.date,format:.dateTime.day().month().hour().minute()).foregroundStyle(.secondary)}
                Text(r.result).textSelection(.enabled)
                Text("Пройдено шагов: \(r.completed) из \(r.total)").font(.caption).foregroundStyle(.secondary)
            }.padding(.vertical,10)
        }.overlay {if automation.records.isEmpty {ContentUnavailableView("История пуста",systemImage:"clock",description:Text("Запустите или проверьте команду — результат появится здесь."))}}
    }
}
struct PreferencesView:View {
    @EnvironmentObject var hotKey:GlobalHotKey
    @EnvironmentObject var voice:Voice
    @EnvironmentObject var model:DesktopModel
    @AppStorage("speechProvider") var provider="system"
    @AppStorage("systemVoice") var systemVoice=""
    @AppStorage("serverVoice") var serverVoice="marin"
    @AppStorage("fishVoice") var fishVoice=""
    @AppStorage("wakePhrase") var wakePhrase="Агент"
    @AppStorage("appearance") var appearance="system"
    @AppStorage("accent") var accent="forest"
    @AppStorage("animations") var animations=true
    @AppStorage("avatarOpacity") var opacity=0.94
    @State var fishKey=""
    @State var note=""
    var body:some View {
        Form {
            Section("Голос") {
                Picker("Озвучка",selection:$provider) {Text("На Mac · без интернета").tag("system");Text("OpenAI · через сервер Лида").tag("server");Text("Fish Audio · свой ключ").tag("fish")}
                if provider=="system" {Picker("Системный голос",selection:$systemVoice){Text("Русский по умолчанию").tag("");ForEach(AVSpeechSynthesisVoice.speechVoices().filter{$0.language.hasPrefix("ru")},id:\.identifier){Text($0.name).tag($0.identifier)}} }
                if provider=="server" {Picker("Голос",selection:$serverVoice){ForEach(["marin","cedar","coral","sage","nova","alloy","ash","onyx","shimmer"],id:\.self){Text($0.capitalized).tag($0)}};Text("Текст озвучки отправляется вашему серверу и провайдеру OpenAI.").font(.caption).foregroundStyle(.secondary)}
                if provider=="fish" {SecureField("API-ключ Fish Audio",text:$fishKey);TextField("ID голоса",text:$fishVoice);Button("Сохранить ключ в Связке ключей"){do{guard !fishKey.isEmpty else{return};try Vault.save(fishKey,server:"fish-audio");fishKey="";note="Ключ сохранён"}catch{note=error.localizedDescription}};Text("Текст отправляется Fish Audio. Нужны ваш ключ и доступный ID голоса.").font(.caption).foregroundStyle(.secondary)}
                HStack {Button("Послушать голос"){voice.read("Здравствуйте. Я Агент. Готов помочь с вашими задачами.",server:model.data.server)};Button("Стоп"){voice.stopSpeaking()}}
                if !voice.error.isEmpty {Text(voice.error).foregroundStyle(.red)}
                Text(note).font(.caption)
            }
            Section("Обращение по имени") {
                TextField("Фраза пробуждения",text:$wakePhrase)
                Toggle("Слушать сейчас",isOn:Binding(get:{voice.armed},set:{voice.setWake($0)})).disabled(wakePhrase.trimmingCharacters(in:.whitespaces).isEmpty)
                Text("Локальное распознавание. Скажите «\(wakePhrase), открой браузер». Команды с включённым голосовым запуском выполняются по точному совпадению фразы. Остальные задачи появляются в чате для проверки. После получения команды микрофон выключается. При запуске приложения прослушивание всегда выключено.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Внешний вид") {
                Text(hotKey.available ? "Открыть Агента из любого приложения: ⌘⇧Пробел" : "Горячая клавиша занята. Открывайте Агента из строки меню.").font(.callout)
                Picker("Тема",selection:$appearance){Text("Как в macOS").tag("system");Text("Светлая").tag("light");Text("Тёмная").tag("dark")}
                Picker("Акцент",selection:$accent){Text("Лесной").tag("forest");Text("Синий").tag("blue");Text("Графит").tag("graphite")}
                Toggle("Анимация помощника",isOn:$animations)
                LabeledContent("Плотность фона мини-помощника"){Slider(value:$opacity,in:0.5...1)}
            }
            Section("Доступ к Mac") {
                Button("Настроить Универсальный доступ"){NSWorkspace.shared.open(URL(string:"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)}
                Button("Настроить мониторинг ввода"){NSWorkspace.shared.open(URL(string:"x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")!)}
                Text("Универсальный доступ нужен для воспроизведения клавиш и щелчков. Мониторинг ввода — только для записи сценариев.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Управление с телефона") {
                Text("В приложении «Агент» на iPhone или в личном чате Лида отправляйте задачи для Mac. Их выполняет подключённый Mac-исполнитель. Локальные сценарии этого приложения пока запускаются на самом Mac.").foregroundStyle(.secondary)
            }
        }.formStyle(.grouped)
    }
}
