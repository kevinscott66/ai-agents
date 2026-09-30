import SwiftUI
import UniformTypeIdentifiers

struct InstalledApp: Identifiable { let id: String; let name: String }
func installedApps() -> [InstalledApp] {
    var result: [String:InstalledApp] = [:]
    for dir in ["/Applications","/System/Applications","/System/Applications/Utilities",NSHomeDirectory()+"/Applications"] {
        for url in (try? FileManager.default.contentsOfDirectory(at:URL(fileURLWithPath:dir),includingPropertiesForKeys:nil)) ?? [] where url.pathExtension == "app" {
            if let bundle = Bundle(url:url), let id = bundle.bundleIdentifier { result[id] = InstalledApp(id:id,name:url.deletingPathExtension().lastPathComponent) }
        }
    }
    return result.values.sorted{$0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending}
}
struct CommandPack: Identifiable {
    let id: String; let title: String; let note: String; let icon: String; let macros: [Macro]
    static var all: [CommandPack] { [
        .init(id:"daily",title:"Рабочий день",note:"Браузер, календарь и комфортная громкость",icon:"sun.max",macros:[
            Macro(name:"Рабочее утро",phrase:"начни рабочий день",steps:[.init(kind:.application,value:"com.apple.Safari"),.init(kind:.application,value:"com.apple.iCal"),.init(kind:.volume,value:"35")]),
            Macro(name:"Открыть браузер",phrase:"открой браузер",steps:[.init(kind:.application,value:"com.apple.Safari")]),
            Macro(name:"Тихий режим",phrase:"тихий режим",steps:[.init(kind:.volume,value:"10")])]),
        .init(id:"music",title:"Музыка",note:"Открыть Apple Music и переключить воспроизведение",icon:"music.note",macros:[Macro(name:"Музыка — пауза / воспроизведение",phrase:"переключи музыку",steps:[.init(kind:.application,value:"com.apple.Music"),.init(kind:.pause,value:"1"),.init(kind:.shortcut,value:"space",target:"com.apple.Music")])]),
        .init(id:"spotify",title:"Spotify",note:"Нужен установленный Spotify и Универсальный доступ",icon:"play.circle",macros:[Macro(name:"Spotify — пауза / воспроизведение",phrase:"включи спотифай",steps:[.init(kind:.application,value:"com.spotify.client"),.init(kind:.pause,value:"2"),.init(kind:.shortcut,value:"space",target:"com.spotify.client")])]),
        .init(id:"focus",title:"Фокус",note:"Заметки и голосовое напоминание о начале работы",icon:"leaf",macros:[Macro(name:"Время сосредоточиться",phrase:"пора работать",steps:[.init(kind:.application,value:"com.apple.Notes"),.init(kind:.volume,value:"20"),.init(kind:.speech,value:"Начинаем. Какая задача сейчас самая важная?")])])
    ] }
}
struct CommandsView: View {
    @EnvironmentObject var model: DesktopModel
    @EnvironmentObject var automation: Automation
    @State private var editing: Macro?
    @State private var query = ""
    @State private var importError = ""
    var body: some View {
        VStack(alignment:.leading,spacing:16) {
            HStack {
                TextField("Найти команду или фразу",text:$query).textFieldStyle(.roundedBorder)
                Button("Импорт JSON") { importFile() }
                Button("Новая команда",systemImage:"plus") { editing = Macro(name:"Новая команда",phrase:"",steps:[MacroStep()]) }.buttonStyle(.borderedProminent)
            }
            if !importError.isEmpty { Text(importError).foregroundStyle(.red) }
            if model.data.macros.isEmpty { ContentUnavailableView("Ваши команды",systemImage:"command",description:Text("Создайте последовательность действий или добавьте готовый набор.")) }
            ScrollView {
                LazyVStack(spacing:12) {
                    ForEach(model.data.macros.filter{query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.phrase.localizedCaseInsensitiveContains(query)}) { macro in
                        HStack(spacing:16) {
                            Image(systemName:"square.stack.3d.up").font(.title2).foregroundStyle(.secondary)
                            VStack(alignment:.leading,spacing:5) { Text(macro.name).font(.headline); Text(macro.phrase.isEmpty ? "\(macro.steps.count) действий" : "«\(macro.phrase)» · \(macro.steps.count) действий").font(.callout).foregroundStyle(.secondary) }
                            Spacer()
                            Button("Изменить") { editing = macro }
                            Button { automation.run(macro) } label: { Image(systemName:"play.fill") }.disabled(automation.running || automation.recording).help("Выполнить сценарий")
                        }.padding(18).background(.quaternary.opacity(0.35),in:RoundedRectangle(cornerRadius:16))
                        .contextMenu { Button("Экспорт JSON") { exportFile(macro) }; Button("Удалить",role:.destructive) { model.deleteMacro(macro.id) } }
                    }
                }
            }
            if automation.running { HStack { ProgressView().controlSize(.small);Text(automation.status);Spacer();Button("Стоп") { automation.cancel() } } }
        }.sheet(item:$editing) { MacroEditor(macro:$0).environmentObject(model).environmentObject(automation) }
    }
    private func importFile() {
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.json]; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { let bytes = try Data(contentsOf:url);guard bytes.count < 32000 else { throw DesktopError.message("Файл слишком большой") };editing = try MacroProposal.parse(String(decoding:bytes,as:UTF8.self)) } catch { importError = error.localizedDescription }
    }
    private func exportFile(_ macro: Macro) {
        let panel = NSSavePanel();panel.allowedContentTypes = [.json];panel.nameFieldStringValue = "command.json"
        if panel.runModal() == .OK,let url = panel.url { do { try JSONEncoder().encode(macro).write(to:url,options:.atomic) } catch { importError = error.localizedDescription } }
    }
}
struct MacroEditor: View {
    @EnvironmentObject var model: DesktopModel
    @EnvironmentObject var automation: Automation
    @Environment(\.dismiss) var dismiss
    @State var macro: Macro
    @State private var error = ""
    @State private var description = ""
    @State private var apps = installedApps()
    var body: some View {
        VStack(alignment:.leading,spacing:16) {
            HStack { Text("Редактор команды").font(.title2.bold());Spacer();Button("Закрыть") { automation.stopRecording();dismiss() } }
            HStack { TextField("Название",text:$macro.name);TextField("Фраза активации",text:$macro.phrase) }.textFieldStyle(.roundedBorder)
            Toggle("Выполнять эту команду голосом после обращения к Агенту",isOn:Binding(get:{macro.voiceEnabled ?? false},set:{macro.voiceEnabled=$0}))
            HStack {
                Button(automation.recording ? "Остановить запись" : "Записать действия",systemImage:automation.recording ? "stop.circle" : "record.circle") { if automation.recording { automation.stopRecording() } else { automation.startRecording() } }
                if !automation.captured.isEmpty { Button("Добавить запись: \(automation.captured.count) шагов") { macro.steps += automation.captured; automation.captured = [] } }
            }
            Text(automation.recording ? "Идёт запись щелчков и сочетаний ⌘/⌥ в других приложениях. Обычный ввод текста не записывается. До 60 секунд." : "Запись сохраняется как редактируемые шаги и не запускается автоматически.").font(.caption).foregroundStyle(automation.recording ? .red : .secondary)
            if !automation.permissionError.isEmpty { Text(automation.permissionError).font(.caption).foregroundStyle(.red) }
            ScrollView {
                VStack(spacing:12) {
                    ForEach($macro.steps) { $step in
                        VStack(alignment:.leading,spacing:8) {
                            HStack {
                                Text("\((macro.steps.firstIndex(where:{$0.id == step.id}) ?? 0)+1)").monospacedDigit().foregroundStyle(.secondary)
                                Picker("Действие",selection:$step.kind) { ForEach(MacroStep.Kind.allCases,id:\.self) { Text($0.label).tag($0) } }.labelsHidden()
                                Button { move(step.id,-1) } label:{Image(systemName:"arrow.up")};Button { move(step.id,1) } label:{Image(systemName:"arrow.down")}
                                Button(role:.destructive) { macro.steps.removeAll{$0.id == step.id} } label:{Image(systemName:"trash")}
                            }
                            if step.kind == .application {
                                Picker("Приложение",selection:$step.value) { Text("Выберите…").tag("");ForEach(apps) { Text($0.name).tag($0.id) };if !step.value.isEmpty && !apps.contains(where:{$0.id == step.value}) {Text(step.value).tag(step.value)} }
                            } else { TextField(hint(step.kind),text:$step.value).textFieldStyle(.roundedBorder) }
                            if step.kind == .shortcut || step.kind == .click {
                                Picker("В приложении",selection:Binding(get:{step.target ?? ""},set:{step.target = $0})) { Text("Выберите…").tag("");ForEach(apps) { Text($0.name).tag($0.id) };if let target=step.target,!target.isEmpty && !apps.contains(where:{$0.id == target}) {Text(target).tag(target)} }
                            }
                        }.padding(12).background(.quaternary.opacity(0.3),in:RoundedRectangle(cornerRadius:10))
                    }
                }
            }
            HStack { Button("Добавить шаг",systemImage:"plus") { macro.steps.append(MacroStep()) }.disabled(macro.steps.count>=20);Spacer();Text("\(macro.steps.count) / 20").foregroundStyle(.secondary) }
            DisclosureGroup("Создать с помощью Лида") {
                TextField("Например: открой браузер, подожди 2 секунды и календарь",text:$description).textFieldStyle(.roundedBorder)
                HStack {
                    Button(model.busy ? "Лид готовит сценарий…" : "Составить сценарий") { Task { await model.createScenario(description) } }.disabled(!model.connected || model.busy || !model.data.pending.isEmpty || description.isEmpty)
                    Button("Взять последний ответ Лида") { do { guard let text=model.data.messages.last(where:{$0.role == "Лид"})?.text else {throw DesktopError.message("Ответа пока нет")}; macro=try MacroProposal.parse(text);error="" } catch { self.error=error.localizedDescription } }
                }
                Text("Лид готовит предложение. Проверьте шаги перед сохранением и запуском.").font(.caption).foregroundStyle(.secondary)
            }
            if !error.isEmpty { Text(error).foregroundStyle(.red) }
            HStack {
                Button("Проверить без выполнения") { automation.run(macro,dryRun:true) }.disabled(automation.running)
                Text(automation.status).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                Spacer();Button("Сохранить") { do { try model.saveMacro(macro);automation.stopRecording();dismiss() } catch { self.error=error.localizedDescription } }.buttonStyle(.borderedProminent).disabled(automation.recording)
            }
        }.padding(24).frame(width:760,height:740).onDisappear{automation.stopRecording()}
    }
    func move(_ id:UUID,_ delta:Int) { if let i=macro.steps.firstIndex(where:{$0.id==id}),macro.steps.indices.contains(i+delta){macro.steps.swapAt(i,i+delta)} }
    func hint(_ kind:MacroStep.Kind)->String { switch kind {case .website:return "https://…";case .volume:return "0–100";case .pause:return "0–30 секунд";case .shortcut:return "copy, paste, save, space, return…";case .click:return "x, y — координаты экрана";default:return "Текст"} }
}
struct PacksView: View {
    @EnvironmentObject var model:DesktopModel
    @State var error=""
    var body: some View {
        ScrollView { LazyVGrid(columns:[GridItem(.adaptive(minimum:270))],spacing:18) {
            ForEach(CommandPack.all) { pack in
                VStack(alignment:.leading,spacing:15) {
                    Image(systemName:pack.icon).font(.largeTitle).foregroundStyle(.tint)
                    Text(pack.title).font(.title2.bold());Text(pack.note).foregroundStyle(.secondary).frame(minHeight:45,alignment:.topLeading)
                    ForEach(pack.macros) { Text("• "+$0.name).font(.callout) }
                    Spacer(minLength:10)
                    Button("Добавить команды") { do { for macro in pack.macros where !model.data.macros.contains(where:{$0.name == macro.name}) {try model.saveMacro(macro)};error="Набор добавлен в «Команды»" } catch { self.error=error.localizedDescription } }.buttonStyle(.bordered)
                }.padding(22).frame(maxWidth:.infinity,minHeight:280,alignment:.topLeading).background(.quaternary.opacity(0.3),in:RoundedRectangle(cornerRadius:18))
            }
        };Text(error).padding() }
    }
}
