import Foundation
import XCTest
@testable import CentyChat

/// Opening a chat at a message found by the search: the history around it is loaded.
@MainActor
final class ChatJumpTests: XCTestCase {
    private var app: TestApp!
    private let key = ConversationKey(type: .direct, targetId: 12)

    override func setUp() async throws {
        app = TestApp()
        app.session.currentUser = TestModels.me
        // 200 messages in the dialog; the newest page holds 151...200.
        var history: [Message] = []
        for id in Int64(1)...Int64(200) {
            let mine = id % 2 == 0
            history.append(TestModels.message(id: id, from: mine ? 1 : 12, to: mine ? 12 : 1))
        }
        let messages = history
        app.chat.state.withValue { $0.messages[key] = messages }
    }

    override func tearDown() async throws {
        app = nil
    }

    func testAMessageOutsideTheNewestPageIsLoadedWithItsNeighbours() async {
        let chat = app.container.chats.store(for: key)
        await chat.load()
        XCTAssertFalse(chat.messages.contains { $0.id == 40 })

        let found = await chat.loadAround(40)

        XCTAssertTrue(found)
        let ids = chat.messages.map(\.id)
        XCTAssertTrue(ids.contains(40))
        XCTAssertTrue(ids.contains(39), "Older neighbours are loaded")
        XCTAssertTrue(ids.contains(41), "Newer neighbours are loaded")
        XCTAssertTrue(ids.contains(200), "The newest page stays")
        XCTAssertEqual(ids, ids.sorted(), "History stays in order")
        XCTAssertEqual(Set(ids).count, ids.count, "No duplicates")
    }

    func testAMessageAlreadyOnScreenNeedsNoRequest() async {
        let chat = app.container.chats.store(for: key)
        await chat.load()
        let before = app.chat.state.value.pageRequests

        let found = await chat.loadAround(180)

        XCTAssertTrue(found)
        XCTAssertEqual(app.chat.state.value.pageRequests, before)
    }

    func testAMessageThatNoLongerExistsIsReported() async {
        app.chat.state.withValue { state in
            state.messages[key] = state.messages[key]?.filter { $0.id != 40 }
        }
        let chat = app.container.chats.store(for: key)
        await chat.load()

        let found = await chat.loadAround(40)

        XCTAssertFalse(found)
        XCTAssertEqual(chat.messages.map(\.id), chat.messages.map(\.id).sorted())
    }

    func testReloadingAfterAJumpKeepsTheOrder() async {
        let chat = app.container.chats.store(for: key)
        await chat.load()
        _ = await chat.loadAround(40)

        await chat.load()

        let ids = chat.messages.map(\.id)
        XCTAssertEqual(ids, ids.sorted(), "A reload (reconnect) must not put old history after the newest page")
        XCTAssertTrue(ids.contains(40))
    }

    func testPendingMessagesStayAtTheBottom() async {
        let chat = app.container.chats.store(for: key)
        await chat.load()
        await chat.send(text: "ещё не доставлено")

        _ = await chat.loadAround(40)

        XCTAssertEqual(chat.messages.last?.text, "ещё не доставлено")
    }
}
