import Foundation
import XCTest
@testable import CentyChat

/// The chat on the delivery core: the composer, reply/edit/delete, older pages, and whose queue it is
/// when the session ends.
@MainActor
final class ChatOutboxTests: XCTestCase {
    private var app: TestApp!
    private let key = ConversationKey(type: .direct, targetId: 12)

    override func setUp() async throws {
        app = TestApp()
        app.session.currentUser = TestModels.me
    }

    override func tearDown() async throws {
        app = nil
    }

    private func openChat(history: [Message] = []) async -> ChatStore {
        app.chat.state.withValue { $0.messages[key] = history }
        let store = app.container.chats.store(for: key)
        await store.load()
        return store
    }

    private func frames(_ type: String) async -> [JSONObject] {
        await app.realtime.sentFrames.filter { $0["type"]?.string == type }
    }

    // MARK: - Composer (§7.4)

    func testTheComposerKeepsItsTextWhenTheMessageCouldNotBeStored() async {
        let chat = await openChat()
        await app.deliveryStore.fail(.persist, times: 1)

        let refused = await chat.send(text: "Важное")
        XCTAssertFalse(refused, "not on disk: the composer keeps the text")
        XCTAssertTrue(chat.messages.isEmpty)
        XCTAssertNotNil(chat.notice)

        let accepted = await chat.send(text: "Важное")
        XCTAssertTrue(accepted)
        XCTAssertEqual(chat.messages.map(\.sendState), [.queued])
    }

    func testAMessageWaitsVisiblyUntilTheSocketIsUpThenGoesOnce() async throws {
        let chat = await openChat()
        await chat.send(text: "Без сети")
        XCTAssertEqual(chat.messages.first?.sendState, .queued)
        let sentOffline = await frames("send_message")
        XCTAssertTrue(sentOffline.isEmpty)

        await app.goOnline()

        let sent = await frames("send_message")
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(chat.messages.first?.sendState, .sending)
        let key = try XCTUnwrap(sent.first?["client_msg_id"]?.string)
        await app.deliver(#"{"type":"direct_message","message":{"id":900,"conversation_type":"direct","target_id":12,"sender_id":1,"text":"Без сети","type":"text","created_at":"2026-10-05T09:00:00.000Z","updated_at":null,"is_deleted":0,"client_msg_id":"\#(key)","sender_name":"Тест Тестов"}}"#)
        XCTAssertEqual(chat.messages.map(\.id), [900])
        XCTAssertEqual(chat.messages.first?.deliveryStatus, .sent)
    }

    // MARK: - Reply, edit, delete

    func testAReplyCarriesTheOriginalsId() async throws {
        let original = TestModels.message(id: 300, from: 12, to: 1, text: "Когда отчёт?")
        let chat = await openChat(history: [original])
        await app.goOnline()

        let replyTo = try XCTUnwrap(chat.messages.first)
        await chat.send(text: "Сегодня", replyTo: replyTo)
        await app.settleDelivery()

        let sent = await frames("send_message")
        XCTAssertEqual(sent.last?["replyToId"], 300)
        XCTAssertEqual(chat.messages.last?.replyQuote?.text, "Когда отчёт?")
    }

    func testEditingAndDeletingAnOwnMessageGoThroughTheQueue() async throws {
        let chat = await openChat(history: [TestModels.message(id: 301, from: 1, to: 12, text: "Было")])
        await app.goOnline()
        let mine = try XCTUnwrap(chat.messages.first)

        let edited = await chat.edit(mine, text: "Стало")
        await app.settleDelivery()
        XCTAssertTrue(edited)
        let edits = await frames("edit_message")
        XCTAssertEqual(edits.first?["messageId"], 301)
        XCTAssertEqual(edits.first?["text"], "Стало")

        await chat.delete(mine)
        await app.settleDelivery()
        let deletes = await frames("delete_message")
        XCTAssertEqual(deletes.first?["messageId"], 301)
        XCTAssertTrue(chat.messages.isEmpty, "a message being deleted is hidden until its tombstone (§3.4)")
    }

    func testDeletingAnUnsentMessageMeansItIsNeverSent() async throws {
        let chat = await openChat()
        await chat.send(text: "Передумал")
        let unsent = try XCTUnwrap(chat.messages.first)

        await chat.delete(unsent)
        await app.goOnline()

        let sent = await frames("send_message")
        XCTAssertTrue(sent.isEmpty)
        XCTAssertTrue(chat.messages.isEmpty)
    }

    // MARK: - Older pages (beforeId)

    func testReachingTheTopLoadsThePageBeforeTheOldestMessage() async {
        let history = (1...120).map { TestModels.message(id: Int64($0), from: 12, to: 1) }
        let chat = await openChat(history: history)
        XCTAssertEqual(chat.messages.first?.id, 71)

        await chat.loadOlder()

        XCTAssertEqual(app.chat.state.value.pageRequests.last, "before:71")
        XCTAssertEqual(chat.messages.first?.id, 21)
        XCTAssertEqual(chat.messages.count, 100)
    }

    // MARK: - Whose queue it is

    private func signIn(as user: User) async throws {
        app.auth.state.withValue { $0.loginUser = user }
        _ = try await app.session.login(username: user.username, password: "secret")
        await app.settleDelivery()
    }

    func testAnExplicitSignOutDeletesTheUnsentMessages() async throws {
        try await signIn(as: TestModels.me)
        let chat = await openChat()
        await chat.send(text: "Не успело")
        XCTAssertEqual(app.container.delivery.unsentCount, 1)

        await app.session.logout()

        let stored = await app.deliveryStore.contents
        XCTAssertTrue(stored.outbox.isEmpty)
        XCTAssertEqual(app.session.phase, .signedOut)
    }

    func testASessionThatEndsByItselfKeepsTheQueueForTheSameAccount() async throws {
        try await signIn(as: TestModels.me)
        let chat = await openChat()
        await chat.send(text: "Дождусь")
        app.auth.state.withValue { $0.currentUserResult = .failure(APIError.unauthorized) }

        await app.session.revalidate(reason: "Сессия истекла")
        XCTAssertEqual(app.session.phase, .signedOut)
        let kept = await app.deliveryStore.contents
        XCTAssertEqual(kept.outbox.map(\.text), ["Дождусь"], "a revoked token is not the user signing out")

        try await signIn(as: TestModels.me)
        XCTAssertEqual(app.engine.state.outbox.map(\.text), ["Дождусь"])
    }

    func testAnotherAccountSigningInNeverInheritsTheQueue() async throws {
        try await signIn(as: TestModels.me)
        let chat = await openChat()
        await chat.send(text: "Моё")
        app.auth.state.withValue { $0.currentUserResult = .failure(APIError.unauthorized) }
        await app.session.revalidate(reason: "Сессия истекла")

        try await signIn(as: TestModels.colleague)
        await app.goOnline(as: TestModels.colleague.id)

        XCTAssertTrue(app.engine.state.outbox.isEmpty)
        let sent = await frames("send_message")
        XCTAssertTrue(sent.isEmpty, "nothing of one account is sent in another's session")
        let stored = await app.deliveryStore.contents
        XCTAssertTrue(stored.outbox.isEmpty)
    }

    func testASignOutThatCannotDeleteTheUnsentMessagesIsCancelled() async throws {
        try await signIn(as: TestModels.me)
        let chat = await openChat()
        await chat.send(text: "Останусь")
        await app.deliveryStore.fail(.clear, times: 1)

        await app.session.logout()

        XCTAssertEqual(app.session.phase, .authenticated)
        XCTAssertEqual(app.session.errorMessage, "Не удалось удалить неотправленные сообщения — выход отменён")
    }
}
