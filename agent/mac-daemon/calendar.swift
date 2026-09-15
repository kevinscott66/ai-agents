import Foundation
import EventKit

// Fixed command surface. Runtime reads never trigger a permission dialog.
let store = EKEventStore()
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
let command = CommandLine.arguments.dropFirst().first ?? ""
if command == "authorize" {
    var finished = false
    var allowed = false
    let completion: (Bool, Error?) -> Void = { granted, _ in
        DispatchQueue.main.async { allowed = granted; finished = true }
    }
    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents(completion: completion)
    } else {
        store.requestAccess(to: .event, completion: completion)
    }
    let deadline = Date().addingTimeInterval(60)
    while !finished && Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    }
    guard finished && allowed else { fail("calendar_access_denied") }
    print("Calendar access granted")
    exit(0)
}
guard command == "today" else { fail("expected_today_or_authorize") }
let status = EKEventStore.authorizationStatus(for: .event)
if #available(macOS 14.0, *) {
    guard status == .fullAccess else { fail("calendar_access_required") }
} else {
    guard status == .authorized else { fail("calendar_access_required") }
}
let calendar = Calendar.current
let start = calendar.startOfDay(for: Date())
guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { fail("date_error") }
let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
let events = store.events(matching: predicate).filter { $0.status != .canceled }.sorted { $0.startDate < $1.startDate }
let iso = ISO8601DateFormatter()
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
let result: [String: Any] = ["date": date.string(from: start), "timeZone": calendar.timeZone.identifier,
                             "events": rows, "truncated": events.count > 40]
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
