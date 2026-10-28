// daebot-calendar: Daebot's Apple Calendar helper for the Mac app.
//
// One JSON request on stdin, one JSON reply on stdout, then it exits:
//   request  {"op": "status" | "request" | "calendars" | "events" | "create" | "update" | "delete", "args": {...}}
//   reply    {"ok": true, "result": ...}   or   {"ok": false, "error": "a sentence the user can act on"}
//
// The Electron main process spawns it once per call, from our own window only. Because it runs inside the Daebot app, macOS attributes
// the Calendar prompt to Daebot, so the person never leaves the app. It uses EventKit (requestFullAccessToEvents on macOS 14+,
// requestAccess(to:) before that). Op shapes are identical to the iPhone app's bridge:
//   status    -> {access: granted | denied | notDetermined | restricted | writeOnly}
//   request   -> shows the OS prompt when notDetermined, returns the status
//   calendars -> [{id, title, color, source, allowsModify}]
//   events    {start, end, calendarIds?, query?} -> [{id, calendarId, calendarTitle, title, start, end, allDay, location, notes, url}] (max 500)
//   create    {calendarId?, title, start, end, allDay?, location?, notes?, alarmsMinutes?} -> the event
//   update    {id, ...fields} -> the event
//   delete    {id} -> {deleted: true}
// Times are ISO 8601 with an offset, in this Mac's time zone.

import Foundation
import EventKit
import CoreGraphics

struct Fail: Error { let message: String }

let store = EKEventStore()
let maxEvents = 500
let maxNotes = 2000

// MARK: - dates

let outFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    f.timeZone = TimeZone.current
    return f
}()

func iso(_ d: Date) -> String { outFormatter.string(from: d) }

func parseDate(_ s: String, field: String) throws -> Date {
    let t = s.trimmingCharacters(in: .whitespaces)
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    if let d = plain.date(from: t) { return d }
    let frac = ISO8601DateFormatter()
    frac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = frac.date(from: t) { return d }
    // Offsets without a colon (+0100) and times without seconds.
    for pattern in ["yyyy-MM-dd'T'HH:mm:ssZ", "yyyy-MM-dd'T'HH:mmZZZZZ", "yyyy-MM-dd'T'HH:mmZ", "yyyy-MM-dd'T'HH:mm:ss.SSSZ"] {
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.dateFormat = pattern
        if let d = df.date(from: t) { return d }
    }
    throw Fail(message: "\(field) is not a valid ISO 8601 date-time with an offset, for example 2026-10-29T14:00:00-04:00.")
}

// MARK: - access

func accessString() -> String {
    // rawValue: 0 notDetermined, 1 restricted, 2 denied, 3 authorized / fullAccess, 4 writeOnly (macOS 14+).
    switch EKEventStore.authorizationStatus(for: .event).rawValue {
    case 0: return "notDetermined"
    case 1: return "restricted"
    case 2: return "denied"
    case 3: return "granted"
    case 4: return "writeOnly"
    default: return "notDetermined"
    }
}

func requireAccess(write: Bool) throws {
    switch accessString() {
    case "granted": return
    case "writeOnly":
        if write { return }
        throw Fail(message: "Daebot can only add events to Calendar, not read them. Turn on full access in System Settings > Privacy & Security > Calendars.")
    case "denied":
        throw Fail(message: "Calendar access is off for Daebot. Turn it on in System Settings > Privacy & Security > Calendars.")
    case "restricted":
        throw Fail(message: "Calendar access is restricted on this Mac (a profile or Screen Time limit), so Daebot cannot open it.")
    default:
        throw Fail(message: "Daebot has not asked for Calendar access yet. Ask Daebot to request access, then answer the prompt.")
    }
}

func requestAccess() throws -> [String: Any] {
    if accessString() != "notDetermined" { return ["access": accessString()] }
    let done = DispatchSemaphore(value: 0)
    var failure: String?
    let handler: EKEventStoreRequestAccessCompletionHandler = { _, error in
        if let error = error { failure = error.localizedDescription }
        done.signal()
    }
    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents(completion: handler)
    } else {
        store.requestAccess(to: .event, completion: handler)
    }
    // The person is reading a prompt; the app gives up on its side a little later than this.
    if done.wait(timeout: .now() + 125) == .timedOut {
        throw Fail(message: "The Calendar permission prompt was not answered in time. Ask again when you are ready to answer it.")
    }
    if let failure = failure, accessString() == "notDetermined" { throw Fail(message: "Calendar access could not be requested: \(failure)") }
    return ["access": accessString()]
}

// MARK: - JSON of calendars and events

func hex(_ color: CGColor?) -> String {
    guard let color = color,
          let space = CGColorSpace(name: CGColorSpace.sRGB),
          let c = color.converted(to: space, intent: .defaultIntent, options: nil),
          let comps = c.components, comps.count >= 3 else { return "#808080" }
    func byte(_ v: CGFloat) -> Int { max(0, min(255, Int((v * 255).rounded()))) }
    return String(format: "#%02X%02X%02X", byte(comps[0]), byte(comps[1]), byte(comps[2]))
}

func calendarJSON(_ c: EKCalendar) -> [String: Any] {
    return [
        "id": c.calendarIdentifier,
        "title": c.title,
        "color": hex(c.cgColor),
        "source": c.source?.title ?? "",
        "allowsModify": c.allowsContentModifications,
    ]
}

/// A recurring event has ONE eventIdentifier for every occurrence, and event(withIdentifier:) answers with the FIRST occurrence. So an
/// occurrence is addressed as "<eventIdentifier>@<start as unix seconds>" and found again by its start time. A one-off event is its plain identifier.
func idOf(_ e: EKEvent) -> String {
    let base = e.eventIdentifier ?? ""
    if e.hasRecurrenceRules || e.occurrenceDate != nil && e.occurrenceDate != e.startDate {
        let at = e.occurrenceDate ?? e.startDate ?? Date()
        return "\(base)@\(Int(at.timeIntervalSince1970))"
    }
    return base
}

func eventJSON(_ e: EKEvent) -> [String: Any] {
    var notes = e.notes ?? ""
    if notes.count > maxNotes { notes = String(notes.prefix(maxNotes)) }
    return [
        "id": idOf(e),
        "calendarId": e.calendar?.calendarIdentifier ?? "",
        "calendarTitle": e.calendar?.title ?? "",
        "title": e.title ?? "",
        "start": iso(e.startDate ?? Date()),
        "end": iso(e.endDate ?? e.startDate ?? Date()),
        "allDay": e.isAllDay,
        "location": e.location ?? "",
        "notes": notes,
        "url": e.url?.absoluteString ?? "",
    ]
}

func findEvent(_ rawId: String) throws -> EKEvent {
    let parts = rawId.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: false)
    let base = String(parts[0])
    if parts.count == 2, let secs = TimeInterval(parts[1]) {
        let at = Date(timeIntervalSince1970: secs)
        let pred = store.predicateForEvents(withStart: at.addingTimeInterval(-60), end: at.addingTimeInterval(60), calendars: nil)
        if let hit = store.events(matching: pred).first(where: { $0.eventIdentifier == base }) { return hit }
        throw Fail(message: "That event is no longer in Calendar. Read the events again and pick it from the list.")
    }
    if let e = store.event(withIdentifier: base) { return e }
    throw Fail(message: "That event is no longer in Calendar. Read the events again and pick it from the list.")
}

// MARK: - args

func string(_ a: [String: Any], _ k: String) -> String? {
    guard let v = a[k] as? String else { return nil }
    return v
}

func alarms(_ a: [String: Any]) throws -> [EKAlarm]? {
    guard let raw = a["alarmsMinutes"] else { return nil }
    guard let list = raw as? [Any] else { throw Fail(message: "alarmsMinutes must be a list of minutes before the start.") }
    return try list.map { item in
        guard let m = (item as? NSNumber)?.doubleValue, m >= 0 else { throw Fail(message: "alarmsMinutes must be a list of minutes before the start.") }
        return EKAlarm(relativeOffset: -m * 60)
    }
}

/// All-day events run from midnight to the end of their last day. ISO callers usually send an exclusive midnight end; keep it inside the last day.
func allDayRange(_ start: Date, _ end: Date) -> (Date, Date) {
    let cal = Calendar.current
    let s = cal.startOfDay(for: start)
    var e = end
    if e <= s { e = cal.date(byAdding: .day, value: 1, to: s)!.addingTimeInterval(-1) }
    else if e == cal.startOfDay(for: e) { e = e.addingTimeInterval(-1) }
    return (s, e)
}

func targetCalendar(_ id: String?) throws -> EKCalendar {
    if let id = id, !id.isEmpty {
        guard let c = store.calendar(withIdentifier: id) else { throw Fail(message: "That calendar is not on this Mac. Read the calendars again and pick one from the list.") }
        guard c.allowsContentModifications else { throw Fail(message: "The calendar \"\(c.title)\" is read-only. Pick another calendar to add to.") }
        return c
    }
    guard let c = store.defaultCalendarForNewEvents else {
        throw Fail(message: "There is no default calendar to add to. Set one in Calendar > Settings > General, or pick a calendar.")
    }
    return c
}

// MARK: - ops

func run(op: String, args: [String: Any]) throws -> Any {
    switch op {
    case "status":
        return ["access": accessString()]

    case "request":
        return try requestAccess()

    case "calendars":
        try requireAccess(write: false)
        return store.calendars(for: .event).sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }.map(calendarJSON)

    case "events":
        try requireAccess(write: false)
        guard let s = string(args, "start") else { throw Fail(message: "start is required.") }
        guard let e = string(args, "end") else { throw Fail(message: "end is required.") }
        let start = try parseDate(s, field: "start"), end = try parseDate(e, field: "end")
        if end <= start { throw Fail(message: "end must be after start.") }
        var cals: [EKCalendar]? = nil
        if let ids = args["calendarIds"] as? [String], !ids.isEmpty {
            let want = Set(ids)
            cals = store.calendars(for: .event).filter { want.contains($0.calendarIdentifier) }
            if cals!.isEmpty { return [Any]() }
        }
        let pred = store.predicateForEvents(withStart: start, end: end, calendars: cals)
        var events = store.events(matching: pred).sorted { ($0.startDate ?? .distantPast) < ($1.startDate ?? .distantPast) }
        if let q = string(args, "query")?.trimmingCharacters(in: .whitespaces).lowercased(), !q.isEmpty {
            events = events.filter { ($0.title ?? "").lowercased().contains(q) || ($0.location ?? "").lowercased().contains(q) || ($0.notes ?? "").lowercased().contains(q) }
        }
        return events.prefix(maxEvents).map(eventJSON)

    case "create":
        try requireAccess(write: true)
        guard let title = string(args, "title")?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else { throw Fail(message: "title is required.") }
        guard let s = string(args, "start") else { throw Fail(message: "start is required.") }
        guard let e = string(args, "end") else { throw Fail(message: "end is required.") }
        let start = try parseDate(s, field: "start"), end = try parseDate(e, field: "end")
        if end < start { throw Fail(message: "end must not be before start.") }
        let ev = EKEvent(eventStore: store)
        ev.calendar = try targetCalendar(string(args, "calendarId"))
        ev.title = title
        let allDay = (args["allDay"] as? Bool) ?? false
        ev.isAllDay = allDay
        if allDay { let r = allDayRange(start, end); ev.startDate = r.0; ev.endDate = r.1 } else { ev.startDate = start; ev.endDate = end }
        if let l = string(args, "location"), !l.isEmpty { ev.location = l }
        if let n = string(args, "notes"), !n.isEmpty { ev.notes = n }
        if let list = try alarms(args) { for a in list { ev.addAlarm(a) } }
        try store.save(ev, span: .thisEvent, commit: true)
        return eventJSON(ev)

    case "update":
        try requireAccess(write: false)
        guard let id = string(args, "id"), !id.isEmpty else { throw Fail(message: "id is required.") }
        let ev = try findEvent(id)
        guard ev.calendar?.allowsContentModifications ?? false else { throw Fail(message: "That event is in a read-only calendar, so Daebot cannot change it.") }
        let oldDuration = (ev.endDate ?? ev.startDate ?? Date()).timeIntervalSince(ev.startDate ?? Date())
        if let t = string(args, "title") { let v = t.trimmingCharacters(in: .whitespacesAndNewlines); if v.isEmpty { throw Fail(message: "title cannot be empty.") }; ev.title = v }
        if let l = args["location"] as? String { ev.location = l.isEmpty ? nil : l }
        if let n = args["notes"] as? String { ev.notes = n.isEmpty ? nil : n }
        if let c = string(args, "calendarId"), !c.isEmpty { ev.calendar = try targetCalendar(c) }
        var start = ev.startDate ?? Date(), end = ev.endDate ?? start
        if let s = string(args, "start") { start = try parseDate(s, field: "start"); end = start.addingTimeInterval(max(oldDuration, 0)) }
        if let e = string(args, "end") { end = try parseDate(e, field: "end") }
        if end < start { throw Fail(message: "end must not be before start.") }
        if let a = args["allDay"] as? Bool { ev.isAllDay = a }
        if ev.isAllDay { let r = allDayRange(start, end); ev.startDate = r.0; ev.endDate = r.1 } else { ev.startDate = start; ev.endDate = end }
        if let list = try alarms(args) {
            for old in ev.alarms ?? [] { ev.removeAlarm(old) }
            for a in list { ev.addAlarm(a) }
        }
        try store.save(ev, span: .thisEvent, commit: true)
        return eventJSON(ev)

    case "delete":
        try requireAccess(write: false)
        guard let id = string(args, "id"), !id.isEmpty else { throw Fail(message: "id is required.") }
        let ev = try findEvent(id)
        guard ev.calendar?.allowsContentModifications ?? false else { throw Fail(message: "That event is in a read-only calendar, so Daebot cannot delete it.") }
        try store.remove(ev, span: .thisEvent, commit: true)
        return ["deleted": true]

    default:
        throw Fail(message: "That Calendar request is not supported.")
    }
}

// MARK: - main

func reply(_ object: [String: Any]) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [])) ?? Data("{\"ok\":false,\"error\":\"Calendar could not write its answer.\"}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let json = try? JSONSerialization.jsonObject(with: input, options: []), let req = json as? [String: Any], let op = req["op"] as? String else {
    reply(["ok": false, "error": "Daebot sent Calendar a request it could not read."])
}
do {
    let result = try run(op: op, args: (req["args"] as? [String: Any]) ?? [:])
    reply(["ok": true, "result": result])
} catch let f as Fail {
    reply(["ok": false, "error": f.message])
} catch {
    reply(["ok": false, "error": error.localizedDescription])
}
