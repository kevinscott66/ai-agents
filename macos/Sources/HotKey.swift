import AppKit
import Carbon
import Combine

final class GlobalHotKey: ObservableObject {
    @Published var available=false
    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    init() {
        var event = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _,_,_ in
            DispatchQueue.main.async {
                NSApp.activate(ignoringOtherApps:true)
                NSApp.windows.first(where:{$0.title == "Агент"})?.makeKeyAndOrderFront(nil)
            }
            return noErr
        }, 1, &event, nil, &handler)
        let id = EventHotKeyID(signature: OSType(0x41474E54), id: 1)
        available = RegisterEventHotKey(UInt32(kVK_Space), UInt32(shiftKey | cmdKey), id, GetApplicationEventTarget(), 0, &hotKey) == noErr
    }
    deinit { if let hotKey {UnregisterEventHotKey(hotKey)}; if let handler {RemoveEventHandler(handler)} }
}
