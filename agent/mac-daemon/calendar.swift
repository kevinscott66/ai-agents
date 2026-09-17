import Foundation
import EventKit

// Fixed command surface. Runtime reads and writes never trigger a permission
// dialog: access is granted once by the owner via `authorize` / `authorize-reminders`.
let store = EKEventStore()
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
func waitFor(_ done: () -> Bool, seconds: TimeInterval) {
    let deadline = Date().addingTimeInterval(seconds)
    while !done() && Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    }
}
func requestAccess(_ entity: EKEntityType) -> Bool {
    var finished = false
    var allowed = false
    let completion: (Bool, Error?) -> Void = { granted, _ in
        DispatchQueue.main.async { allowed = granted; finished = true }
    }
    if #available(macOS 14.0, *) {
        if entity == .event { store.requestFullAccessToEvents(completion: completion) }
        else { store.requestFullAccessToReminders(completion: completion) }
    } else {
        store.requestAccess(to: entity, completion: completion)
    }
    waitFor({ finished }, seconds: 60)
    return finished && allowed
}
func hasAccess(_ entity: EKEntityType) -> Bool {
    let status = EKEventStore.authorizationStatus(for: entity)
    if #available(macOS 14.0, *) { return status == .fullAccess }
    return status == .authorized
}
func writeJSON(_ object: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { fail("json_error") }
    FileHandle.standardOutput.write(data)
}
/// Title: one visible line, 1...200 characters, no control or format characters.
func title(_ raw: String?) -> String {
    guard let raw = raw, !raw.trimmingCharacters(in: .whitespaces).isEmpty, raw.count <= 200,
          raw.unicodeScalars.allSatisfy({ ![.control, .format, .lineSeparator, .paragraphSeparator].contains($0.properties.generalCategory) })
    else { fail("invalid_arguments") }
    return raw
}
/// Unix seconds as a positive integer string.
func seconds(_ raw: String?) -> Date {
    guard let raw = raw, raw.allSatisfy({ $0.isASCII && $0.isNumber }), let value = Int64(raw), value > 0
    else { fail("invalid_arguments") }
    return Date(timeIntervalSince1970: TimeInterval(value))
}

let args = Array(CommandLine.arguments.dropFirst())
let command = args.first ?? ""
let iso = ISO8601DateFormatter()

switch command {
case "authorize":
    guard requestAccess(.event) else { fail("calendar_access_denied") }
    print("Calendar access granted")
case "authorize-reminders":
    guard requestAccess(.reminder) else { fail("reminders_access_denied") }
    print("Reminders access granted")
case "today":
    guard args.count == 1 else { fail("invalid_arguments") }
    guard hasAccess(.event) else { fail("calendar_access_required") }
    let calendar = Calendar.current
    let start = calendar.startOfDay(for: Date())
    guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { fail("date_error") }
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
    let events = store.events(matching: predicate).filter { $0.status != .canceled }.sorted { $0.startDate < $1.startDate }
    let date = DateFormatter()
    date.calendar = Calendar(identifier: .gregorian)
    date.locale = Locale(identifier: "en_US_POSIX")
    date.timeZone = calendar.timeZone
    date.dateFormat = "yyyy-MM-dd"
    let rows: [[String: Any]] = events.prefix(40).map { event in
        ["title": String((event.title ?? "Без названия").prefix(100)),
         "start": iso.string(from: event.startDate), "end": iso.string(from: event.endDate),
         "allDay": event.isAllDay]
    }
    writeJSON(["date": date.string(from: start), "timeZone": calendar.timeZone.identifier,
               "events": rows, "truncated": events.count > 40])
case "reminders":
    guard args.count == 1 else { fail("invalid_arguments") }
    guard hasAccess(.reminder) else { fail("reminders_access_required") }
    var fetched: [EKReminder]? = nil
    var finished = false
    let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
    store.fetchReminders(matching: predicate) { reminders in
        DispatchQueue.main.async { fetched = reminders; finished = true }
    }
    waitFor({ finished }, seconds: 15)
    guard finished else { fail("reminders_timeout") }
    let due: (EKReminder) -> Date? = { $0.dueDateComponents.flatMap { Calendar.current.date(from: $0) } }
    let all = (fetched ?? []).sorted { a, b in
        switch (due(a), due(b)) {
        case let (x?, y?): return x < y
        case (.some, .none): return true
        default: return false
        }
    }
    let rows: [[String: Any]] = all.prefix(40).map { reminder in
        ["title": String((reminder.title ?? "Без названия").prefix(200)),
         "due": due(reminder).map { iso.string(from: $0) as Any } ?? NSNull()]
    }
    writeJSON(["reminders": rows, "truncated": all.count > 40])
case "reminder-add":
    guard args.count == 2 || args.count == 3 else { fail("invalid_arguments") }
    let name = title(args[1])
    guard hasAccess(.reminder) else { fail("reminders_access_required") }
    guard let list = store.defaultCalendarForNewReminders() else { fail("reminders_access_required") }
    let reminder = EKReminder(eventStore: store)
    reminder.title = name
    reminder.calendar = list
    if args.count == 3 {
        let at = seconds(args[2])
        reminder.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .timeZone], from: at)
        reminder.addAlarm(EKAlarm(absoluteDate: at))
    }
    do { try store.save(reminder, commit: true) } catch { fail("save_failed") }
    writeJSON(["ok": true])
case "event-add":
    guard args.count == 4 else { fail("invalid_arguments") }
    let name = title(args[1])
    let start = seconds(args[2]), end = seconds(args[3])
    guard end > start, end.timeIntervalSince(start) <= 24 * 3600 else { fail("invalid_arguments") }
    guard hasAccess(.event) else { fail("calendar_access_required") }
    guard let calendar = store.defaultCalendarForNewEvents else { fail("calendar_access_required") }
    let event = EKEvent(eventStore: store)
    event.title = name
    event.calendar = calendar
    event.startDate = start
    event.endDate = end
    do { try store.save(event, span: .thisEvent, commit: true) } catch { fail("save_failed") }
    writeJSON(["ok": true])
default:
    fail("unknown_command")
}
