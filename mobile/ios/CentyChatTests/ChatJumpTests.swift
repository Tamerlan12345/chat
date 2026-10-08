import Foundation
import XCTest
@testable import CentyChat

/// Opening a chat at a message found by the search: the chat holds one continuous stretch of
/// history from a little before the message up to the newest one, so realtime messages continue it
/// without a hole (as Android's `HistoryWindow`).
@MainActor
final class ChatJumpTests: XCTestCase {
    private var app: TestApp!
    private let key = ConversationKey(type: .direct, targetId: 12)

    override func setUp() async throws {
        app = TestApp()
        app.session.currentUser = TestModels.me
        // 200 messages in the dialog; the newest page holds 151...200.
        setHistory(last: 200)
    }

    override func tearDown() async throws {
        app = nil
    }

    private func setHistory(last: Int64) {
        var history: [Message] = []
        for id in Int64(1)...last {
            let mine = id % 2 == 0
            history.append(TestModels.message(id: id, from: mine ? 1 : 12, to: mine ? 12 : 1))
        }
        let messages = history
        app.chat.state.withValue { $0.messages[key] = messages }
    }

    func testTheChatHoldsOneContinuousStretchFromTheHitToTheNewestMessage() async {
        let chat = app.container.chats.store(for: key)
        await chat.load()
        XCTAssertFalse(chat.messages.contains { $0.id == 40 })

        let found = await chat.loadAround(40)

        XCTAssertTrue(found)
        XCTAssertEqual(
            chat.messages.map(\.id),
            Array(Int64(10)...Int64(200)),
            "30 older messages, the hit and everything newer up to the newest, without a gap"
        )
    }

    func testTooManyNewerMessagesFallBackToTheNewestPageWithoutAGap() async {
        setHistory(last: 1_300)
        let chat = app.container.chats.store(for: key)
        await chat.load()

        let found = await chat.loadAround(40)

        XCTAssertFalse(found, "More than 5 × 200 newer messages: no jump, the chat opens at the end")
        XCTAssertEqual(chat.messages.map(\.id), Array(Int64(1_251)...Int64(1_300)), "Only the newest page, no second stretch")
    }

    func testAMessageThatNoLongerExistsLeavesTheNewestPage() async {
        app.chat.state.withValue { state in
            state.messages[key] = state.messages[key]?.filter { $0.id != 40 }
        }
        let chat = app.container.chats.store(for: key)
        await chat.load()

        let found = await chat.loadAround(40)

        XCTAssertFalse(found)
        XCTAssertEqual(chat.messages.map(\.id), Array(Int64(151)...Int64(200)))
    }

    func testOpeningAtAGoneHitSaysSo() async {
        app.chat.state.withValue { state in
            state.messages[key] = state.messages[key]?.filter { $0.id != 40 }
        }
        let chat = app.container.chats.store(for: key)
        await chat.load()

        let found = await chat.open(at: 40)

        XCTAssertFalse(found)
        XCTAssertEqual(chat.notice?.text, "Сообщение не найдено — возможно, его удалили")
    }

    func testOpeningAtAnExistingHitSaysNothing() async {
        let chat = app.container.chats.store(for: key)
        await chat.load()

        let found = await chat.open(at: 40)

        XCTAssertTrue(found)
        XCTAssertNil(chat.notice)
    }

    func testAMessageAlreadyOnScreenNeedsNoRequest() async {
        let chat = app.container.chats.store(for: key)
        await chat.load()
        let before = app.chat.state.value.pageRequests

        let found = await chat.loadAround(180)

        XCTAssertTrue(found)
        XCTAssertEqual(app.chat.state.value.pageRequests, before)
    }

    func testReloadingAfterAJumpKeepsTheStretchContinuous() async {
        let chat = app.container.chats.store(for: key)
        await chat.load()
        _ = await chat.loadAround(40)

        await chat.load()

        XCTAssertEqual(chat.messages.map(\.id), Array(Int64(10)...Int64(200)), "A reload (reconnect) keeps one ordered stretch")
    }

    func testPendingMessagesStayAtTheBottom() async {
        let chat = app.container.chats.store(for: key)
        await chat.load()
        await chat.send(text: "ещё не доставлено")

        _ = await chat.loadAround(40)

        XCTAssertEqual(chat.messages.last?.text, "ещё не доставлено")
        XCTAssertEqual(chat.messages.dropLast().map(\.id), Array(Int64(10)...Int64(200)))
    }
}

/// The time of a message found by the search: Russian, as in the inbox, whatever the device region.
final class SearchHitTimeTests: XCTestCase {
    private let almaty = TimeZone(identifier: "Asia/Almaty")!

    /// 2026-10-05 18:00 in Almaty (UTC+5).
    private let now = Date(timeIntervalSince1970: 1_791_205_200)

    func testTodayShowsOnlyTheTime() {
        let morning = now.addingTimeInterval(-8 * 3600 - 28 * 60) // 09:32
        XCTAssertEqual(SearchHitTime.text(for: morning, now: now, timeZone: almaty), "09:32")
    }

    func testOtherDaysShowDayShortMonthAndTime() {
        let earlier = now.addingTimeInterval(-3 * 86_400 - 2 * 3600) // 2 Oct, 16:00
        XCTAssertEqual(SearchHitTime.text(for: earlier, now: now, timeZone: almaty), "2 окт., 16:00")
    }
}

/// The history window on its own, with a server that answers like `/api/messages`.
@MainActor
final class HistoryWindowTests: XCTestCase {
    /// A dialog with messages 1...`last`; records the requests.
    private final class Server {
        let last: Int64
        var requests: [String] = []

        init(last: Int64) {
            self.last = last
        }

        func before(_ beforeId: Int64, _ limit: Int) -> [Message] {
            requests.append("before \(beforeId) \(limit)")
            let first = max(1, beforeId - Int64(limit))
            return first < beforeId ? (first..<beforeId).map { message($0) } : []
        }

        func after(_ afterId: Int64, _ limit: Int) -> [Message] {
            requests.append("after \(afterId) \(limit)")
            let end = min(last, afterId + Int64(limit))
            return afterId < end ? ((afterId + 1)...end).map { message($0) } : []
        }

        private func message(_ id: Int64) -> Message {
            TestModels.message(id: id, from: 2, to: 1)
        }
    }

    func testTheWindowHoldsTheMessageItsContextAndEverythingNewer() async throws {
        let server = Server(last: 300)
        let window = try await HistoryWindow.around(100, before: { server.before($0, $1) }, after: { server.after($0, $1) })
        XCTAssertEqual(window?.map(\.id), Array(Int64(70)...Int64(300)), "Continuous, without repeats")
        XCTAssertEqual(server.requests, ["before 101 31", "after 100 200", "after 300 200"])
    }

    func testTooManyNewerMessagesGiveUpInsteadOfLeavingAGap() async throws {
        let server = Server(last: 5_000)
        let window = try await HistoryWindow.around(100, before: { server.before($0, $1) }, after: { server.after($0, $1) })
        XCTAssertNil(window)
        XCTAssertEqual(server.requests.count, 1 + HistoryWindow.maxPages)
    }

    func testAMessageThatIsGoneGivesUp() async throws {
        let window = try await HistoryWindow.around(
            50,
            before: { _, _ in [TestModels.message(id: 48, from: 2, to: 1), TestModels.message(id: 49, from: 2, to: 1)] },
            after: { _, _ in [] }
        )
        XCTAssertNil(window)
    }
}
