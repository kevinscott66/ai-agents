import SwiftUI

@main struct AgentDesktop: App {
    @StateObject private var model = DesktopModel()
    @StateObject private var hotKey = GlobalHotKey()
    @StateObject private var voice = Voice()
    @StateObject private var automation = Automation()
    @StateObject private var remote = RemoteDesktop()
    @AppStorage("appearance") var appearance="system"
    @AppStorage("accent") var accent="forest"
    var tint:Color { accent=="blue" ? .blue : accent=="graphite" ? .gray : Color(red:0.32,green:0.41,blue:0.32) }
    var body: some Scene {
        Window("Агент", id: "main") {
            DesktopView().environmentObject(model).environmentObject(voice).environmentObject(automation).environmentObject(hotKey).environmentObject(remote).tint(tint).preferredColorScheme(appearance=="dark" ? .dark : appearance=="light" ? .light : nil)
                .frame(minWidth: 800, minHeight: 580)
        }.defaultSize(width: 1050, height: 720)
        Window("Мини-помощник",id:"companion") { CompanionView().environmentObject(model).environmentObject(voice).environmentObject(automation).tint(tint) }.windowResizability(.contentSize)
        Window("Виртуальный офис", id: "office") { OfficeWindow(server:model.data.server) }.defaultSize(width: 1200, height: 800)
        MenuBarExtra("Агент", systemImage: "waveform.circle") { MenuActions().environmentObject(remote) }
    }
}
struct MenuActions: View {
    @EnvironmentObject var remote:RemoteDesktop
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Button("Открыть Агента") { NSApp.activate(ignoringOtherApps: true); openWindow(id: "main") }
        Button("Мини-помощник") { openWindow(id:"companion") }
        Button("Виртуальный офис") { NSApp.activate(ignoringOtherApps: true); openWindow(id: "office") }
        if remote.enabled { Button("Остановить удалённый доступ"){remote.stop()} }
        Divider()
        Button("Завершить") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}
struct DesktopView: View {
    @EnvironmentObject private var model: DesktopModel
    @Environment(\.openWindow) private var openWindow
    @EnvironmentObject private var voice: Voice
    @EnvironmentObject private var automation: Automation
    @EnvironmentObject private var remote:RemoteDesktop
    @State private var section = "Обзор"
    @State private var draft = ""
    @State private var server = AppConfiguration.server
    @State private var code = ""
    @State private var repairing = false
    var body: some View {
        NavigationSplitView {
            List(selection: $section) {
                Label("Обзор", systemImage: "square.grid.2x2").tag("Обзор")
                Label("Чат", systemImage: "bubble.left.and.bubble.right").tag("Чат")
                Label("Команды", systemImage: "command").tag("Команды")
                Label("Наборы", systemImage: "square.stack.3d.up").tag("Наборы")
                Label("История", systemImage: "clock").tag("История")
                Label("Настройки", systemImage: "slider.horizontal.3").tag("Настройки")
                Label("Экран Mac",systemImage:"desktopcomputer").tag("Экран Mac")
                Label("Офис", systemImage: "building.2").tag("Офис")
                Label("Подключение", systemImage: "network").tag("Подключение")
            }.navigationTitle("Агент").navigationSplitViewColumnWidth(190)
        } detail: {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text(section).font(.largeTitle.bold())
                    Spacer()
                    Label(model.connected ? "Подключение сохранено" : "Нет подключения", systemImage: model.connected ? "checkmark.circle" : "circle")
                        .font(.callout).foregroundStyle(.secondary)
                }
                if remote.enabled { HStack {Label(remote.active ? "Экран передаётся" : "Удалённый доступ включён",systemImage:"record.circle").foregroundStyle(.red);Spacer();Button("Остановить"){remote.stop()}} }
                if !model.error.isEmpty { Text(model.error).foregroundStyle(.red).textSelection(.enabled) }
                if section == "Обзор" { ScrollView { Dashboard(section:$section) } }
                else if section == "Команды" { CommandsView() }
                else if section == "Наборы" { PacksView() }
                else if section == "История" { HistoryView() }
                else if section == "Настройки" { PreferencesView() }
                else if section == "Чат" { chat }
                else if section == "Экран Mac" { RemoteDesktopView() }
                else if section == "Офис" { office }
                else { settings }
            }.padding(28)
        }
        .onChange(of:model.data.server){_,_ in remote.stop()}
        .onChange(of: voice.transcript) { _, value in if !voice.armed { draft = value } }
         .onChange(of: voice.wakeDraft) { _, value in
            if !value.isEmpty {
                if let macro=model.data.macros.first(where:{$0.voiceEnabled == true && !$0.phrase.isEmpty && $0.phrase.lowercased() == value.lowercased()}) { automation.run(macro); section="Обзор" }
                else { draft=value;section="Чат" }
                NSApp.activate(ignoringOtherApps:true)
            }
        }
        .task { if model.connected && !model.data.pending.isEmpty { await model.resume() } }
    }
    private var chat: some View {
        VStack(spacing: 12) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 24) {
                        if model.data.messages.isEmpty {
                            VStack(alignment: .leading, spacing: 14) {
                                Image(systemName: "waveform.circle.fill").font(.system(size: 54)).foregroundStyle(.secondary)
                                Text("Чем займёмся?").font(.title)
                                Text("Напишите задачу или продиктуйте её. Лид продолжит работу через подключённые инструменты.").foregroundStyle(.secondary)
                            }.padding(.vertical, 45)
                        }
                        ForEach(model.data.messages) { message in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(message.role).font(.caption).foregroundStyle(.secondary)
                                Text(message.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                                if message.role == "Лид" { Button { voice.read(message.text, server:model.data.server) } label: { Label("Прочитать", systemImage: "speaker.wave.2") }.buttonStyle(.borderless) }
                            }.padding(16).background(message.role == "Вы" ? Color.primary.opacity(0.04) : .clear, in: RoundedRectangle(cornerRadius: 14))
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                }.onChange(of: model.data.messages.count) { _, _ in proxy.scrollTo("end") }
            }
            if let macro = model.data.macros.first(where:{!$0.phrase.isEmpty && $0.phrase.lowercased() == draft.trimmingCharacters(in:.whitespacesAndNewlines).lowercased()}) {
                HStack {Label(macro.name,systemImage:"command");Spacer();Button("Выполнить на Mac") {voice.setWake(false);automation.run(macro);draft=""}.disabled(automation.running || automation.recording)}.padding(12).background(.quaternary,in:RoundedRectangle(cornerRadius:10))
            }
            if model.busy { HStack { ProgressView().controlSize(.small); Text("Агент работает…").foregroundStyle(.secondary); Spacer() } }
            if !model.data.pending.isEmpty && !model.busy { Button("Проверить ответ") { Task { await model.resume() } } }
            if !voice.error.isEmpty { Text(voice.error).foregroundStyle(.red).font(.caption) }
            HStack(alignment: .bottom, spacing: 12) {
                TextField("Спросите Агента", text: $draft, axis: .vertical).lineLimit(1...6).textFieldStyle(.plain).padding(10)
                Button { if voice.listening || voice.armed { voice.setWake(false) } else { voice.setWake(false); Task { await voice.start() } } } label: { Image(systemName: voice.listening ? "stop.circle.fill" : "mic") }.help(voice.listening ? "Завершить диктовку" : "Диктовать")
                Button { voice.setWake(false); let text = draft; draft = ""; Task { await model.send(text) } } label: { Image(systemName: "arrow.up.circle.fill").font(.title) }
                    .buttonStyle(.plain).disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy || !model.connected || !model.data.pending.isEmpty)
            }.padding(10).background(.background, in: RoundedRectangle(cornerRadius: 18)).overlay(RoundedRectangle(cornerRadius: 18).stroke(.quaternary))
        }
    }
    private var office: some View {
        VStack(alignment: .leading, spacing: 20) {
            Image(systemName: "building.2.crop.circle").font(.system(size: 64)).foregroundStyle(.secondary)
            Text("Команда рядом").font(.title)
            Text("Откройте виртуальный офис в отдельном окне и расположите его рядом с чатом. Вход сохраняется на этом Mac.").foregroundStyle(.secondary).frame(maxWidth: 490, alignment: .leading)
            Button("Открыть офис") { openWindow(id: "office") }.buttonStyle(.borderedProminent).controlSize(.large)
            Text("После закрытия окна 3D-сцена выгружается.").font(.caption).foregroundStyle(.secondary)
            Spacer()
        }.padding(.top, 35)
    }
    private var settings: some View {
        Form {
            Text("Подключение к Лиду").font(.title2)
            if !model.connected || repairing {
            TextField("Сервер", text: $server)
            SecureField("Одноразовый код", text: $code)
            Text("Единая команда для iPhone, Mac и офиса — /pair_native в личном чате Лида. Код действует 5 минут и используется один раз. Вход сохраняется в Связке ключей macOS.").font(.callout).foregroundStyle(.secondary)
            Button("Подключить Mac") { Task { await model.pair(server: server, code: code.trimmingCharacters(in: .whitespacesAndNewlines)); code = ""; if model.connected { repairing = false } } }.disabled(model.busy)
            } else {
                Label("Вход сохранён на этом Mac", systemImage: "checkmark.shield")
                Text("Код повторно не нужен после перезапуска. Офис сохраняет отдельную браузерную сессию.").foregroundStyle(.secondary)
                Button("Подключить заново") { repairing = true }
            }
            Text("Голос распознаётся на Mac. Отправка выполняется после нажатия стрелки.").foregroundStyle(.secondary)
        }.formStyle(.grouped).onAppear { server = model.data.server }
    }
}
