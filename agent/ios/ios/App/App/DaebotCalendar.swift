import UIKit
import WebKit
import EventKit

// MARK: - Calendar: the page asks the device (EventKit); Apple's own permission prompt appears inside the app

/// JS: `await window.webkit.messageHandlers.daebotCalendar.postMessage({ op, args })` resolves `{ ok: true, result }` or
/// `{ ok: false, error }` (error is a plain sentence a person can act on). Never rejects, so the page handles one shape.
///
/// Ops: status, request, calendars, events, create, update, delete (shapes in the Daebot calendar contract).
///
/// Only the MAIN frame of an https page on daebot.live (or a subdomain) is served; every other page, frame or scheme is refused,
/// so no other site and no embedded frame can read or change the calendar. WebKit cannot scope a handler to an origin, so the
/// check happens on every message, from the frame's own security origin (not from a URL the page could spoof).
///
/// Recurring events: an occurrence's id is `<eventIdentifier>|<occurrence start, unix seconds>`, and update/delete touch THAT
/// occurrence only (EKSpan.thisEvent), never the whole series. A one-off event's id is its plain eventIdentifier.
final class DaebotCalendarHandler: NSObject, WKScriptMessageHandlerWithReply {
    static let handlerName = "daebotCalendar"

    private struct Failure: Error {
        let message: String
        init(_ message: String) { self.message = message }
    }

    private let store = EKEventStore()
    /// EKEventStore is used from this one serial queue only.
    private let queue = DispatchQueue(label: "live.daebot.calendar", qos: .userInitiated)
    private let isoOut: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private let isoIn: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private let isoInFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let maxEvents = 500

    // MARK: Origin gate

    /// Pure so it can be checked in a table: https, the default port, daebot.live or *.daebot.live, main frame only.
    static func isTrusted(protocol scheme: String, host rawHost: String, port: Int, isMainFrame: Bool) -> Bool {
        guard isMainFrame, scheme.lowercased() == "https", port == 0 || port == 443 else { return false }
        let host = rawHost.lowercased()
        return host == "daebot.live" || (host.hasSuffix(".daebot.live") && host.count > ".daebot.live".count)
    }

    // MARK: WKScriptMessageHandlerWithReply

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let reply: (Any) -> Void = { payload in DispatchQueue.main.async { replyHandler(payload, nil) } }
        let origin = message.frameInfo.securityOrigin
        guard Self.isTrusted(protocol: origin.protocol, host: origin.host, port: origin.port, isMainFrame: message.frameInfo.isMainFrame) else {
            reply(Self.failure("Calendar access is only available to Daebot's own pages on daebot.live."))
            return
        }
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
            reply(Self.failure("Daebot sent a calendar request this iPhone could not read."))
            return
        }
        let args = (body["args"] as? [String: Any]) ?? [:]
        queue.async {
            self.perform(op, args) { result in
                switch result {
                case .success(let value): reply(["ok": true, "result": value])
                case .failure(let failure): reply(Self.failure(failure.message))
                }
            }
        }
    }

    private static func failure(_ message: String) -> [String: Any] { ["ok": false, "error": message] }

    // MARK: Dispatch

    private func perform(_ op: String, _ args: [String: Any], done: @escaping (Result<Any, Failure>) -> Void) {
        isoOut.timeZone = TimeZone.current
        switch op {
        case "status": done(.success(["access": Self.accessString()]))
        case "request": requestAccess(done)
        case "calendars": done(guarded { try self.listCalendars() })
        case "events": done(guarded { try self.listEvents(args) })
        case "create": done(guarded { try self.createEvent(args) })
        case "update": done(guarded { try self.updateEvent(args) })
        case "delete": done(guarded { try self.deleteEvent(args) })
        default: done(.failure(Failure("Daebot asked this iPhone for a calendar action it does not have (\(op.prefix(40))).")))
        }
    }

    /// Runs `body` only with full calendar access; turns every error into a sentence.
    private func guarded(_ body: () throws -> Any) -> Result<Any, Failure> {
        do {
            try requireAccess()
            return .success(try body())
        } catch let failure as Failure {
            return .failure(failure)
        } catch {
            return .failure(Failure("The calendar could not finish that: \(error.localizedDescription)"))
        }
    }

    // MARK: Access

    /// EKAuthorizationStatus raw values are stable: 0 notDetermined, 1 restricted, 2 denied, 3 fullAccess (authorized before iOS 17),
    /// 4 writeOnly (iOS 17+). Read as numbers so one source works on the iOS 15 deployment target and on iOS 17+.
    static func accessString() -> String {
        switch EKEventStore.authorizationStatus(for: .event).rawValue {
        case 0: return "notDetermined"
        case 1: return "restricted"
        case 2: return "denied"
        case 3: return "granted"
        case 4: return "writeOnly"
        default: return "denied"
        }
    }

    private static var settingsPath: String {
        if #available(iOS 18.0, *) { return "Settings > Apps > Daebot > Calendars" }
        return "Settings > Daebot > Calendars"
    }

    private func requireAccess() throws {
        switch Self.accessString() {
        case "granted":
            store.refreshSourcesIfNecessary()
        case "notDetermined":
            throw Failure("Daebot has not asked for calendar access yet. Ask Daebot to connect your calendar, then tap Allow Full Access.")
        case "writeOnly":
            throw Failure("Daebot can only add events right now. Turn on Full Access in \(Self.settingsPath).")
        case "restricted":
            throw Failure("Calendar access is blocked on this iPhone, for example by Screen Time or a device profile, so Daebot cannot use it.")
        default:
            throw Failure("Calendar access is off for Daebot. Turn it on in \(Self.settingsPath).")
        }
    }

    /// Shows Apple's calendar prompt only while the answer is still "notDetermined"; otherwise just reports the status.
    private func requestAccess(_ done: @escaping (Result<Any, Failure>) -> Void) {
        guard Self.accessString() == "notDetermined" else {
            done(.success(["access": Self.accessString()]))
            return
        }
        let finish: (Bool, Error?) -> Void = { _, error in
            let access = Self.accessString()
            if access == "notDetermined", let error = error {
                done(.failure(Failure("Calendar access could not be requested: \(error.localizedDescription)")))
            } else {
                done(.success(["access": access]))
            }
        }
        if #available(iOS 17.0, *) {
            store.requestFullAccessToEvents(completion: finish)
        } else {
            store.requestAccess(to: .event, completion: finish)
        }
    }

    // MARK: Calendars

    private func listCalendars() throws -> Any {
        let calendars = store.calendars(for: .event).sorted {
            let a = ($0.source?.title ?? "", $0.title), b = ($1.source?.title ?? "", $1.title)
            return a.0 == b.0 ? a.1.localizedCaseInsensitiveCompare(b.1) == .orderedAscending
                              : a.0.localizedCaseInsensitiveCompare(b.0) == .orderedAscending
        }
        return calendars.map { c -> [String: Any] in
            ["id": c.calendarIdentifier,
             "title": c.title,
             "color": Self.hex(c.cgColor),
             "source": c.source?.title ?? "",
             "allowsModify": c.allowsContentModifications]
        }
    }

    private static func hex(_ color: CGColor?) -> String {
        guard let color = color else { return "#808080" }
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        guard UIColor(cgColor: color).getRed(&r, green: &g, blue: &b, alpha: &a) else { return "#808080" }
        func byte(_ x: CGFloat) -> Int { max(0, min(255, Int((x * 255).rounded()))) }
        return String(format: "#%02X%02X%02X", byte(r), byte(g), byte(b))
    }

    // MARK: Events: read

    private func listEvents(_ a: [String: Any]) throws -> Any {
        let start = try date(a["start"], "start")
        let end = try date(a["end"], "end")
        guard end > start else { throw Failure("The end of the range has to be after its start.") }
        guard end.timeIntervalSince(start) <= 4 * 366 * 86_400 else {
            throw Failure("The calendar can be searched four years at a time. Ask for a shorter range.")
        }
        var scope: [EKCalendar]?
        if let ids = a["calendarIds"] as? [Any], !ids.isEmpty {
            let wanted = Set(ids.compactMap { $0 as? String })
            let matching = store.calendars(for: .event).filter { wanted.contains($0.calendarIdentifier) }
            if matching.isEmpty { return [Any]() }
            scope = matching
        }
        var found = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: scope))
        if let q = (a["query"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !q.isEmpty {
            found = found.filter { e in
                [e.title, e.location, e.notes].contains { ($0 ?? "").localizedCaseInsensitiveContains(q) }
            }
        }
        found.sort { $0.compareStartDate(with: $1) == .orderedAscending }
        return found.prefix(Self.maxEvents).map { eventPayload($0) }
    }

    // MARK: Events: write

    private func createEvent(_ a: [String: Any]) throws -> Any {
        let event = EKEvent(eventStore: store)
        try apply(a, to: event, creating: true)
        try store.save(event, span: .thisEvent, commit: true)
        return eventPayload(event)
    }

    private func updateEvent(_ a: [String: Any]) throws -> Any {
        let event = try findEvent(a["id"])
        try requireEditable(event.calendar)
        try apply(a, to: event, creating: false)
        try store.save(event, span: .thisEvent, commit: true)
        return eventPayload(event)
    }

    private func deleteEvent(_ a: [String: Any]) throws -> Any {
        let event = try findEvent(a["id"])
        try requireEditable(event.calendar)
        try store.remove(event, span: .thisEvent, commit: true)
        return ["deleted": true]
    }

    private func requireEditable(_ calendar: EKCalendar?) throws {
        if let calendar = calendar, !calendar.allowsContentModifications {
            throw Failure("The \(calendar.title) calendar is read-only, so Daebot cannot change it.")
        }
    }

    /// Writes the fields present in `a` onto `event`. A missing key leaves the field alone (update); `null` or "" clears
    /// location, notes and url. Creating needs title, start and end; the calendar defaults to the iPhone's default.
    private func apply(_ a: [String: Any], to event: EKEvent, creating: Bool) throws {
        // Calendar
        if let id = a["calendarId"] as? String, !id.isEmpty {
            guard let calendar = store.calendar(withIdentifier: id) else {
                throw Failure("That calendar was not found. It may have been removed from this iPhone.")
            }
            try requireEditable(calendar)
            event.calendar = calendar
        } else if creating {
            guard let calendar = store.defaultCalendarForNewEvents, calendar.allowsContentModifications else {
                throw Failure("This iPhone has no calendar Daebot can add events to. Open the Calendar app and add or enable one.")
            }
            event.calendar = calendar
        }

        // Title
        if a["title"] != nil || creating {
            guard let title = (a["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else {
                throw Failure(creating ? "An event needs a title." : "The title cannot be empty.")
            }
            event.title = title
        }

        // Times
        let hasStart = !(a["start"] == nil || a["start"] is NSNull)
        let hasEnd = !(a["end"] == nil || a["end"] is NSNull)
        if creating && !(hasStart && hasEnd) { throw Failure("An event needs a start and an end time.") }
        let wasAllDay = event.isAllDay
        let allDay = (a["allDay"] as? Bool) ?? (creating ? false : wasAllDay)
        if creating || hasStart || hasEnd || allDay != wasAllDay {
            let oldStart = event.startDate
            let oldEnd = event.endDate
            let start = try (hasStart ? date(a["start"], "start") : (oldStart ?? Date()))
            var end: Date
            if hasEnd {
                end = try date(a["end"], "end")
            } else if hasStart, let oldStart = oldStart, let oldEnd = oldEnd {
                end = start.addingTimeInterval(oldEnd.timeIntervalSince(oldStart)) // moved the start only: keep the length
            } else {
                end = oldEnd ?? start
            }
            if allDay {
                // An all-day event runs from midnight to 23:59:59 on its last day. An end given as the NEXT midnight (the usual way
                // to say "one whole day") is read as the end of the day before, so a one-day event stays one day.
                let cal = Calendar.current
                if end > start, end == cal.startOfDay(for: end) { end = end.addingTimeInterval(-1) }
                let firstDay = cal.startOfDay(for: start)
                var lastDay = cal.startOfDay(for: end)
                if lastDay < firstDay { lastDay = firstDay }
                event.isAllDay = true
                event.timeZone = nil
                event.startDate = firstDay
                event.endDate = cal.date(byAdding: DateComponents(day: 1, second: -1), to: lastDay) ?? lastDay
            } else {
                guard end >= start else { throw Failure("The event has to end after it starts.") }
                event.isAllDay = false
                event.timeZone = TimeZone.current
                event.startDate = start
                event.endDate = end
            }
        }

        // Text fields
        if a.keys.contains("location") { event.location = Self.text(a["location"]) }
        if a.keys.contains("notes") { event.notes = Self.text(a["notes"]) }
        if a.keys.contains("url") {
            if let raw = Self.text(a["url"]) {
                guard let url = URL(string: raw), url.scheme != nil else { throw Failure("The event link is not a valid web address.") }
                event.url = url
            } else {
                event.url = nil
            }
        }

        // Alerts: minutes before the start. Present = replace them all.
        if a.keys.contains("alarmsMinutes") {
            var minutes: [Double] = []
            if !(a["alarmsMinutes"] is NSNull) {
                guard let list = a["alarmsMinutes"] as? [Any] else { throw Failure("Alerts have to be a list of minutes before the event.") }
                for item in list {
                    guard let n = (item as? NSNumber)?.doubleValue, n >= 0, n <= 60 * 24 * 28 else {
                        throw Failure("Each alert has to be a number of minutes between 0 and 40320.")
                    }
                    minutes.append(n)
                }
            }
            for alarm in event.alarms ?? [] { event.removeAlarm(alarm) }
            for m in minutes { event.addAlarm(EKAlarm(relativeOffset: -m * 60)) }
        }
    }

    private static func text(_ value: Any?) -> String? {
        guard let s = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return s
    }

    // MARK: Event lookup and shape

    private static func eventId(_ e: EKEvent) -> String {
        let base = e.eventIdentifier ?? e.calendarItemIdentifier
        if e.hasRecurrenceRules || e.isDetached, let occurrence = e.occurrenceDate ?? e.startDate {
            return "\(base)|\(Int(occurrence.timeIntervalSince1970))"
        }
        return base
    }

    private func findEvent(_ raw: Any?) throws -> EKEvent {
        let notFound = Failure("That event was not found. It may have been deleted or changed on this iPhone.")
        guard let id = (raw as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty else {
            throw Failure("Daebot did not say which event to use.")
        }
        if let bar = id.lastIndex(of: "|"), let seconds = TimeInterval(id[id.index(after: bar)...]) {
            let base = String(id[..<bar])
            let occurrence = Date(timeIntervalSince1970: seconds)
            let predicate = store.predicateForEvents(withStart: occurrence.addingTimeInterval(-86_400),
                                                     end: occurrence.addingTimeInterval(2 * 86_400), calendars: nil)
            if let match = store.events(matching: predicate).first(where: {
                $0.eventIdentifier == base && abs((($0.occurrenceDate ?? $0.startDate) ?? .distantPast).timeIntervalSince(occurrence)) < 1
            }) { return match }
            throw notFound
        }
        if let event = store.event(withIdentifier: id) { return event }
        throw notFound
    }

    private func eventPayload(_ e: EKEvent) -> [String: Any] {
        let start = e.startDate ?? Date()
        let end = e.endDate ?? start
        return [
            "id": Self.eventId(e),
            "calendarId": (e.calendar?.calendarIdentifier as Any?) ?? NSNull(),
            "calendarTitle": (e.calendar?.title as Any?) ?? NSNull(),
            "title": e.title ?? "",
            "start": isoOut.string(from: start),
            "end": isoOut.string(from: end),
            "allDay": e.isAllDay,
            "location": (Self.text(e.location) as Any?) ?? NSNull(),
            "notes": (Self.text(e.notes) as Any?) ?? NSNull(),
            "url": (e.url?.absoluteString as Any?) ?? NSNull(),
        ]
    }

    // MARK: Dates

    /// ISO 8601 with an offset (or Z). A time with no offset, or a bare date, is read as this iPhone's local time.
    private func date(_ raw: Any?, _ field: String) throws -> Date {
        guard let s = (raw as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else {
            throw Failure("The \(field) time is missing.")
        }
        if let d = isoIn.date(from: s) ?? isoInFraction.date(from: s) { return d }
        for format in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd"] {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = TimeZone.current
            f.dateFormat = format
            if let d = f.date(from: s) { return d }
        }
        throw Failure("The \(field) time is not a date Daebot's calendar understands. Use a form like 2026-10-28T14:00:00-04:00.")
    }
}

// MARK: - Debug-only self-test (compiled out of Release)

#if DEBUG
/// `xcrun simctl launch --console booted live.daebot.app -daebotCalendarSelfTest` loads a local page whose origin is
/// https://daebot.live (loadHTMLString with that base URL, so the real origin check runs, nothing is bypassed), then drives every
/// op through `window.webkit.messageHandlers.daebotCalendar` and prints each reply as `DAEBOT-CAL-TEST <step> => <json>`.
private final class DaebotTestLogger: NSObject, WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        daebotTestLog("DAEBOT-CAL-TEST \(message.body)")
    }
}

private var daebotTestLogger: DaebotTestLogger?

/// stderr is unbuffered, so `simctl launch --console` shows each line as it happens (stdout would sit in a buffer).
private func daebotTestLog(_ line: String) {
    FileHandle.standardError.write(Data((line + "\n").utf8))
}

extension DaebotViewController {
    func runCalendarSelfTestIfRequested() {
        guard CommandLine.arguments.contains("-daebotCalendarSelfTest"), let wv = webView else { return }

        // The origin gate as a table: the logic every real message passes through.
        let table: [(String, String, String, Int, Bool, Bool)] = [
            ("daebot.live main frame", "https", "daebot.live", 0, true, true),
            ("www.daebot.live main frame", "https", "www.daebot.live", 0, true, true),
            ("explicit 443", "https", "daebot.live", 443, true, true),
            ("daebot.live sub-frame", "https", "daebot.live", 0, false, false),
            ("http scheme", "http", "daebot.live", 0, true, false),
            ("other port", "https", "daebot.live", 8443, true, false),
            ("evil-daebot.live", "https", "evil-daebot.live", 0, true, false),
            ("daebot.live.evil.com", "https", "daebot.live.evil.com", 0, true, false),
            ("bare .daebot.live", "https", ".daebot.live", 0, true, false),
            ("m-i-n-d.ai", "https", "m-i-n-d.ai", 0, true, false),
            ("empty origin (about:blank, file:)", "", "", 0, true, false),
        ]
        for (name, scheme, host, port, main, expected) in table {
            let got = DaebotCalendarHandler.isTrusted(protocol: scheme, host: host, port: port, isMainFrame: main)
            daebotTestLog("DAEBOT-CAL-TEST origin-table \(name) expected=\(expected) got=\(got) \(got == expected ? "PASS" : "FAIL")")
        }

        // -daebotCalendarRecurringTest also seeds a 4-week weekly series natively (the contract has no recurrence op), so the
        // handler's per-occurrence ids, update and delete can be checked, then removes it again afterwards.
        let recurring = CommandLine.arguments.contains("-daebotCalendarRecurringTest") && Self.seedRecurringSeries()

        let logger = DaebotTestLogger()
        daebotTestLogger = logger
        wv.configuration.userContentController.add(logger, name: "daebotTestLog")
        wv.loadHTMLString(Self.calendarSelfTestPage, baseURL: URL(string: "https://daebot.live/"))
        pollThenRun(wv, attempt: 0, recurring: recurring)
    }

    private func pollThenRun(_ wv: WKWebView, attempt: Int, recurring: Bool) {
        wv.evaluateJavaScript("location.hostname + '|' + !!document.getElementById('log')") { value, _ in
            if let v = value as? String, v == "daebot.live|true" {
                wv.callAsyncJavaScript(Self.calendarSelfTestScript, arguments: ["recurring": recurring], in: nil, in: .page) { result in
                    if recurring { Self.removeRecurringSeries() }
                    switch result {
                    case .success(let v): daebotTestLog("DAEBOT-CAL-TEST finished \(String(describing: v))")
                    case .failure(let e): daebotTestLog("DAEBOT-CAL-TEST script-error \(e)")
                    }
                }
            } else if attempt < 40 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.pollThenRun(wv, attempt: attempt + 1, recurring: recurring) }
            } else {
                daebotTestLog("DAEBOT-CAL-TEST page-never-loaded")
            }
        }
    }

    private static func seedRecurringSeries() -> Bool {
        let s = EKEventStore()
        guard EKEventStore.authorizationStatus(for: .event).rawValue == 3, let calendar = s.defaultCalendarForNewEvents else {
            daebotTestLog("DAEBOT-CAL-TEST recurring-seed skipped (calendar access not granted yet)")
            return false
        }
        let cal = Calendar.current
        guard let tomorrow = cal.date(byAdding: .day, value: 1, to: Date()),
              let start = cal.date(bySettingHour: 10, minute: 0, second: 0, of: tomorrow) else { return false }
        let e = EKEvent(eventStore: s)
        e.calendar = calendar
        e.title = "Daebot recurring test"
        e.startDate = start
        e.endDate = start.addingTimeInterval(1800)
        e.addRecurrenceRule(EKRecurrenceRule(recurrenceWith: .weekly, interval: 1, end: EKRecurrenceEnd(occurrenceCount: 4)))
        do {
            try s.save(e, span: .futureEvents, commit: true)
            daebotTestLog("DAEBOT-CAL-TEST recurring-seed saved weekly x4 starting \(start)")
            return true
        } catch {
            daebotTestLog("DAEBOT-CAL-TEST recurring-seed failed \(error)")
            return false
        }
    }

    private static func removeRecurringSeries() {
        let s = EKEventStore()
        let from = Date().addingTimeInterval(-86_400), to = Date().addingTimeInterval(60 * 86_400)
        let mine = s.events(matching: s.predicateForEvents(withStart: from, end: to, calendars: nil))
            .filter { ($0.title ?? "").hasPrefix("Daebot recurring test") }
            .sorted { $0.compareStartDate(with: $1) == .orderedAscending }
        if let first = mine.first { try? s.remove(first, span: .futureEvents, commit: true) }
        let left = s.events(matching: s.predicateForEvents(withStart: from, end: to, calendars: nil))
            .filter { ($0.title ?? "").hasPrefix("Daebot recurring test") }.count
        daebotTestLog("DAEBOT-CAL-TEST recurring-cleanup occurrencesLeftAfterRemovingSeries=\(left)")
    }

    private static let calendarSelfTestPage = #"""
    <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body{margin:0;padding:54px 10px 10px;background:#fff;color:#111;font:11px/1.35 ui-monospace,Menlo,monospace}
      h1{font:600 15px -apple-system,sans-serif;margin:0 0 6px}
      pre{white-space:pre-wrap;word-break:break-all;margin:0}
    </style></head><body>
    <h1>Daebot calendar self-test (Debug build)</h1>
    <pre id="log"></pre>
    <iframe id="f" style="display:none" srcdoc="<script>
      window.webkit.messageHandlers.daebotCalendar.postMessage({op:'status'}).then(
        function(r){ window.parent.__frameReply = r; }, function(e){ window.parent.__frameReply = {threw:String(e)}; });
    </script>"></iframe>
    </body></html>
    """#

    private static let calendarSelfTestScript = #"""
    const cal = (op, args) => window.webkit.messageHandlers.daebotCalendar.postMessage({ op, args: args || {} });
    const step = (name, value) => {
      const line = name + ' => ' + JSON.stringify(value);
      window.webkit.messageHandlers.daebotTestLog.postMessage(line);
      document.getElementById('log').textContent += line + '\n\n';
    };
    const pad = (n) => String(n).padStart(2, '0');
    const iso = (d) => {
      const o = -d.getTimezoneOffset(), sign = o >= 0 ? '+' : '-';
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' +
        pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + sign + pad(Math.floor(Math.abs(o) / 60)) + ':' + pad(Math.abs(o) % 60);
    };
    const start = new Date(Date.now() + 3600e3); start.setMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 1800e3);
    const winStart = new Date(Date.now() - 3600e3), winEnd = new Date(Date.now() + 86400e3);
    const window24h = { start: iso(winStart), end: iso(winEnd), query: 'Daebot EventKit test' };

    step('origin', { href: location.href, isTopFrame: window.top === window, handlerType: typeof window.webkit.messageHandlers.daebotCalendar });
    step('status-before', await cal('status'));
    step('request', await cal('request'));
    step('status-after', await cal('status'));
    const cals = await cal('calendars');
    step('calendars', cals);
    const made = await cal('create', { title: 'Daebot EventKit test', start: iso(start), end: iso(end), location: 'Test room',
      notes: 'Created by the Daebot iPhone self-test', alarmsMinutes: [10, 60] });
    step('create', made);
    const id = made.ok ? made.result.id : null;
    step('events', await cal('events', window24h));
    step('update', await cal('update', { id, title: 'Daebot EventKit test (moved)', location: 'Room 2', notes: null }));
    step('events-after-update', await cal('events', { start: window24h.start, end: window24h.end, query: 'Daebot EventKit test (moved)' }));
    step('delete', await cal('delete', { id }));
    step('events-after-delete', await cal('events', window24h));
    step('delete-again', await cal('delete', { id }));
    const day = new Date(Date.now() + 2 * 86400e3); day.setHours(0, 0, 0, 0);
    const next = new Date(day.getTime() + 86400e3);
    const allDay = await cal('create', { title: 'Daebot all-day test', start: iso(day), end: iso(next), allDay: true });
    step('create-all-day', allDay);
    if (allDay.ok) { step('delete-all-day', await cal('delete', { id: allDay.result.id })); }
    step('bad-op', await cal('launchMissiles'));
    step('create-no-title', await cal('create', { start: iso(start), end: iso(end) }));
    step('create-end-before-start', await cal('create', { title: 'x', start: iso(end), end: iso(start) }));
    step('events-bad-date', await cal('events', { start: 'tomorrow', end: 'later' }));
    if (recurring) {
      const w = { start: iso(new Date()), end: iso(new Date(Date.now() + 40 * 86400e3)), query: 'Daebot recurring test' };
      const list = await cal('events', w);
      step('rec-events', list);
      const occ = list.ok ? list.result : [];
      step('rec-ids', new Set(occ.map((o) => o.id)).size + ' distinct ids of ' + occ.length + ' occurrences');
      if (occ.length >= 3) {
        step('rec-update-2nd-only', await cal('update', { id: occ[1].id, title: 'Daebot recurring test (only this one)' }));
        step('rec-delete-3rd-only', await cal('delete', { id: occ[2].id }));
        const after = await cal('events', w);
        step('rec-events-after', after);
        step('rec-summary', after.ok ? after.result.map((o) => o.start.slice(0, 10) + ' ' + o.title) : after);
      }
    }
    step('subframe-reply', window.__frameReply === undefined ? 'no reply (frame message never answered)' : window.__frameReply);
    return 'done';
    """#
}
#endif
