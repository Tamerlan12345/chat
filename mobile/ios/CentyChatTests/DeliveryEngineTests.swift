import Foundation
import XCTest
@testable import CentyChat

/// The delivery engine over an in-memory store, a fake socket and a fake server, on a manual clock.
@MainActor
final class DeliveryEngineTests: XCTestCase {
    private var store: InMemoryDeliveryStore!
    private var link: FakeDeliveryLink!
    private var backend: FakeDeliveryBackend!
    private var clock: ManualDeliveryClock!
    private var logged: Locked<[String]>!

    private let alice: Int64 = 2
    private let bob: Int64 = 3
    private let carol: Int64 = 4

    override func setUp() async throws {
        store = InMemoryDeliveryStore()
        link = FakeDeliveryLink()
        backend = FakeDeliveryBackend()
        clock = ManualDeliveryClock()
        logged = Locked([])
    }

    private func makeEngine(store: InMemoryDeliveryStore? = nil) -> DeliveryEngine {
        let logged = self.logged!
        let engine = DeliveryEngine(
            store: store ?? self.store,
            link: link,
            backend: backend,
            clock: clock,
            log: { line in logged.withValue { $0.append(line) } }
        )
        engine.start()
        return engine
    }

    /// Lets the engine work through its queue and the requests it started.
    private func settle(_ engine: DeliveryEngine) async {
        // Requests run off the main actor; give them real time to answer.
        for _ in 0..<15 {
            await engine.idle()
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
    }

    /// Online as `user`, the first sync chain done.
    private func connect(_ engine: DeliveryEngine, as user: Int64) async {
        engine.receive(DeliveryFixtures.authSuccess(user))
        await settle(engine)
    }

    private func enqueue(_ engine: DeliveryEngine, _ text: String, to peer: Int64 = 3, owner: Int64 = 2, key: String = DeliveryEngine.newClientMsgId()) async -> (DeliveryEngine.Outcome, String) {
        let outcome = await engine.enqueue(conversation: "direct:\(peer)", text: text, clientMsgId: key, owner: owner)
        return (outcome, key)
    }

    // MARK: - Persist barrier and composer (§5, §7.4)

    func testTheComposerClearsOnlyAfterTheEntryIsOnDisk() async {
        let engine = makeEngine()
        await settle(engine)

        let (outcome, key) = await enqueue(engine, "Отчёт готов")

        XCTAssertTrue(outcome.persisted)
        XCTAssertTrue(outcome.composerCleared)
        let stored = await store.contents
        XCTAssertEqual(stored.outbox.map(\.clientMsgId), [key])
        XCTAssertEqual(stored.me, alice, "every stored entry names its account")
    }

    func testAFailedWriteKeepsTheTextInTheComposerAndChangesNothing() async {
        let engine = makeEngine()
        await settle(engine)
        await store.fail(.persist)

        let (outcome, _) = await enqueue(engine, "Не потеряй меня")

        XCTAssertFalse(outcome.persisted)
        XCTAssertFalse(outcome.composerCleared, "§7.4: the composer clears only after a durable enqueue")
        XCTAssertTrue(engine.state.outbox.isEmpty, "§5: the state of a failed step is dropped")
        let stored = await store.contents
        XCTAssertTrue(stored.outbox.isEmpty)
    }

    func testAServerEventThatCannotBeStoredRestartsTheSocketAndKeepsTheCursor() async {
        let engine = makeEngine()
        await settle(engine)
        await store.fail(.persist)

        await connect(engine, as: alice)

        XCTAssertNil(engine.state.sync.cursor, "the page's cursor is not taken without a durable write")
        XCTAssertGreaterThanOrEqual(link.restartCount, 1, "§5: the socket restarts so the next chain returns the same data")
    }

    func testAnAlarmThatCannotBeStoredIsDispatchedAgainASecondLater() async {
        let engine = makeEngine()
        await settle(engine)
        await connect(engine, as: alice)
        let (_, key) = await enqueue(engine, "Тайм-аут")
        await settle(engine)
        XCTAssertEqual(link.sends(of: key), 1)
        await store.fail(.persist, times: 1)

        clock.advance(by: DeliveryReducer.ackTimeoutMs)
        await settle(engine)
        XCTAssertEqual(engine.state.outbox.first?.state, OutboxEntry.sending, "the timeout step was not stored, so it did not happen")

        clock.advance(by: DeliveryEngine.persistRetryMs)
        await settle(engine)
        XCTAssertEqual(engine.state.outbox.first?.state, OutboxEntry.queued, "the same ack_timeout is dispatched again and now taken")
        XCTAssertEqual(engine.state.outbox.first?.failures, 1)
    }

    // MARK: - Sending order and replay (§7.2, §7.6)

    func testMessagesOfOneConversationLeaveFirstInFirstOutOneAtATime() async {
        let engine = makeEngine()
        await settle(engine)
        await connect(engine, as: alice)
        let (_, first) = await enqueue(engine, "первое")
        let (_, second) = await enqueue(engine, "второе")
        let (_, third) = await enqueue(engine, "третье")
        await settle(engine)

        XCTAssertEqual(link.sends(of: first), 1)
        XCTAssertEqual(link.sends(of: second), 0, "stop-and-wait: the second waits for the first's echo")

        engine.receive(DeliveryFixtures.echo(DeliveryFixtures.record(id: 10, from: alice, to: bob, text: "первое", clientMsgId: first)))
        await settle(engine)
        XCTAssertEqual(link.sends(of: second), 1)
        XCTAssertEqual(link.sends(of: third), 0)

        engine.receive(DeliveryFixtures.echo(DeliveryFixtures.record(id: 11, from: alice, to: bob, text: "второе", clientMsgId: second)))
        await settle(engine)
        let order = link.sent.filter { $0["type"]?.string == "send_message" }.compactMap { $0["client_msg_id"]?.string }
        XCTAssertEqual(order, [first, second, third])
    }

    func testAMessageQueuedOfflineIsSentExactlyOnceAfterARestart() async {
        let first = makeEngine()
        await settle(first)
        let (outcome, key) = await enqueue(first, "Без сети")
        XCTAssertTrue(outcome.persisted)
        await settle(first)
        XCTAssertTrue(link.sent.isEmpty, "offline: nothing goes out")

        // A new process over the same store.
        let second = makeEngine()
        await settle(second)
        XCTAssertEqual(second.state.outbox.map(\.clientMsgId), [key])
        XCTAssertTrue(second.ready)
        await connect(second, as: alice)

        XCTAssertEqual(link.sends(of: key), 1, "after the sync chain the entry goes once, with its key")
        second.receive(DeliveryFixtures.echo(DeliveryFixtures.record(id: 30, from: alice, to: bob, text: "Без сети", clientMsgId: key)))
        await settle(second)
        XCTAssertTrue(second.state.outbox.isEmpty)
        XCTAssertEqual(link.sends(of: key), 1)
    }

    func testAMessageTheServerStoredBeforeTheRestartIsConfirmedBySyncAndNotSentAgain() async {
        let first = makeEngine()
        await settle(first)
        let (_, key) = await enqueue(first, "Уже на сервере")

        backend.queueSync(.page([
            "messages": [.object(DeliveryFixtures.record(id: 31, from: alice, to: bob, text: "Уже на сервере", clientMsgId: key))],
            "next_cursor": "c1",
            "has_more": false,
        ]))
        let second = makeEngine()
        await settle(second)
        await connect(second, as: alice)

        XCTAssertEqual(link.sends(of: key), 0)
        XCTAssertTrue(second.state.outbox.isEmpty)
        XCTAssertEqual(second.state.messages["direct:3"]?.map(\.id), [31])
    }

    func testTheConversationCacheComesBackAfterARestart() async {
        let first = makeEngine()
        await settle(first)
        await connect(first, as: alice)
        first.receive(DeliveryFixtures.echo(DeliveryFixtures.record(id: 40, from: bob, to: alice, text: "Привет из кэша")))
        await settle(first)
        clock.advance(by: 1_000)
        await settle(first)

        let second = makeEngine()
        await settle(second)

        XCTAssertEqual(second.state.messages["direct:3"]?.map(\.text), ["Привет из кэша"])
    }

    // MARK: - One sender per entry

    func testTheSocketPumpAndTheHTTPFlushNeverSendTheSameEntryTwice() async {
        let engine = makeEngine()
        await settle(engine)
        let (_, key) = await enqueue(engine, "Один раз")
        let gate = TestGate()
        backend.holdPosts(gate)
        backend.answerPosts { body in
            HTTPOutcome(status: 201, body: .object(DeliveryFixtures.record(id: 50, from: 2, to: 3, text: "Один раз", clientMsgId: body["client_msg_id"]?.string)))
        }

        // The background flush takes the entry; the socket comes up while the request is in flight.
        await engine.backgroundFlush()
        engine.receive(DeliveryFixtures.authSuccess(alice))
        await settle(engine)

        var http = backend.postedBodies.filter { $0["client_msg_id"]?.string == key }.count
        XCTAssertEqual(http, 1)
        XCTAssertEqual(link.sends(of: key), 0, "one serial executor: the socket pump sees the entry in flight")

        await gate.open()
        await settle(engine)
        http = backend.postedBodies.filter { $0["client_msg_id"]?.string == key }.count
        XCTAssertTrue(engine.state.outbox.isEmpty, "confirmed by the HTTP answer")
        XCTAssertEqual(http + link.sends(of: key), 1)
    }

    func testABackgroundFlushWhileTheSocketIsUpLeavesTheEntryToThePump() async {
        let engine = makeEngine()
        await settle(engine)
        await connect(engine, as: alice)
        let (_, key) = await enqueue(engine, "Через сокет")
        await settle(engine)

        // Both senders asked at the same moment: the flush (no socket only) and the pump.
        async let flushed = engine.backgroundFlush()
        async let again = engine.dispatch(["type": "tick"])
        _ = await (flushed, again)
        await settle(engine)

        XCTAssertEqual(backend.postedBodies.count, 0)
        XCTAssertEqual(link.sends(of: key), 1)
    }

    // MARK: - Cancelled is never sent (§7.10)

    func testACancelledMessageIsNeverSentLater() async {
        let engine = makeEngine()
        await settle(engine)
        await connect(engine, as: alice)
        let (_, key) = await enqueue(engine, "Передумал")
        await settle(engine)
        XCTAssertEqual(link.sends(of: key), 1)

        _ = await engine.cancel(clientMsgId: key)
        engine.receive(.closed)
        await connect(engine, as: alice)
        clock.advance(by: 60_000)
        await settle(engine)

        XCTAssertEqual(link.sends(of: key), 1, "a cancelled entry is never sent again")
        XCTAssertTrue(link.sent.contains { $0["type"]?.string == "cancel_message" && $0["client_msg_id"]?.string == key })
        XCTAssertFalse(engine.state.outbox.contains { $0.clientMsgId == key && !$0.pendingDelete })
    }

    // MARK: - Fail closed (store unreadable)

    func testAStoreThatCannotBeReadIsNeverOverwrittenAndTheEngineIsNotReady() async {
        let queued = OutboxEntry(clientMsgId: "a0000001-0000-4000-8000-000000000001", conversation: "direct:3", seq: 1, text: "Сохранённое")
        let broken = InMemoryDeliveryStore(StoredDelivery(me: alice, seq: 1, outbox: [queued]))
        await broken.fail(.load, times: 2)
        let engine = makeEngine(store: broken)
        await settle(engine)

        XCTAssertFalse(engine.ready)
        let (outcome, _) = await enqueue(engine, "Пока нельзя")
        XCTAssertFalse(outcome.persisted, "refused while the store is unreadable: the composer keeps the text")
        engine.receive(DeliveryFixtures.authSuccess(alice))
        await settle(engine)
        let persistedWhileBlocked = await broken.persisted
        XCTAssertTrue(persistedWhileBlocked.isEmpty, "nothing is written over the unread outbox")
        XCTAssertTrue(link.sent.isEmpty)
        XCTAssertTrue(logged.value.contains { $0.contains("could not be read") }, "the failure is logged")

        // Retried with backoff until the store answers.
        clock.advance(by: 1_000)
        await settle(engine)
        clock.advance(by: 2_000)
        await settle(engine)

        XCTAssertTrue(engine.ready)
        XCTAssertEqual(engine.state.outbox.map(\.text), ["Сохранённое"])
    }

    func testSigningOutWhileTheStoreCannotBeReadLeavesAWorkingEmptyQueue() async {
        let broken = InMemoryDeliveryStore()
        await broken.fail(.load)
        let engine = makeEngine(store: broken)
        await settle(engine)
        XCTAssertFalse(engine.ready)

        try? await engine.reset()

        XCTAssertTrue(engine.ready, "an emptied store is readable")
        let (outcome, _) = await enqueue(engine, "После выхода", owner: bob)
        XCTAssertTrue(outcome.persisted)
    }

    // MARK: - The queue belongs to an account

    func testAnotherAccountsSocketNeverSendsThePreviousAccountsMessages() async {
        let engine = makeEngine()
        await settle(engine)
        let (_, key) = await enqueue(engine, "Сообщение Алисы", owner: alice)

        engine.receive(DeliveryFixtures.authSuccess(carol))
        await settle(engine)

        XCTAssertEqual(link.sends(of: key), 0)
        XCTAssertTrue(engine.state.outbox.isEmpty)
        XCTAssertEqual(engine.state.me, carol)
        let stored = await store.contents
        XCTAssertTrue(stored.outbox.isEmpty, "the previous account's queue is wiped from disk too")
    }

    func testTheSameAccountComingBackKeepsItsQueue() async {
        let engine = makeEngine()
        await settle(engine)
        let (_, key) = await enqueue(engine, "Дождётся меня", owner: alice)

        try? await engine.adopt(alice)
        await connect(engine, as: alice)

        XCTAssertEqual(link.sends(of: key), 1)
    }

    func testAdoptingAnotherAccountWipesTheQueueAndANewEntryNamesItsOwner() async {
        let engine = makeEngine()
        await settle(engine)
        _ = await enqueue(engine, "Алиса", owner: alice)
        var wipes = 0
        engine.onWipe.append { wipes += 1 }

        try? await engine.adopt(carol)
        let (outcome, _) = await enqueue(engine, "Кэрол", to: 5, owner: carol)

        XCTAssertEqual(wipes, 1)
        XCTAssertTrue(outcome.persisted)
        XCTAssertEqual(engine.state.outbox.map(\.text), ["Кэрол"])
        let stored = await store.contents
        XCTAssertEqual(stored.me, carol)
    }

    func testAWipeThatFailsIsLoudAndSendsNothing() async {
        let engine = makeEngine()
        await settle(engine)
        let (_, key) = await enqueue(engine, "Удалить при выходе", owner: alice)
        await store.fail(.clear, times: 1)

        do {
            try await engine.reset()
            XCTFail("a failed wipe must reach the sign-out")
        } catch {}
        engine.receive(DeliveryFixtures.authSuccess(alice))
        await settle(engine)
        XCTAssertEqual(link.sends(of: key), 0, "emptied in memory at once: nothing of it is sent")

        clock.advance(by: 1_000)
        await settle(engine)
        let stored = await store.contents
        XCTAssertTrue(stored.outbox.isEmpty, "the wipe is retried")
    }

    func testEveryCommandAnswersItsCallerEvenWhenItFails() async {
        let broken = InMemoryDeliveryStore()
        await broken.fail(.load)
        let engine = makeEngine(store: broken)
        await settle(engine)

        do {
            try await engine.replaceHistory("direct:3", records: [], stale: [])
            XCTFail("replaceHistory must fail while the store is unavailable")
        } catch {}
        let outcome = await engine.dispatch(["type": "conversation_closed"])
        XCTAssertFalse(outcome.persisted)
        try? await engine.adopt(alice)
    }

    // MARK: - The open conversation (§7.8)

    func testAScreenClosedRightAfterItOpenedLeavesNoConversationVisible() async {
        let engine = makeEngine()
        await settle(engine)
        await connect(engine, as: alice)

        engine.conversationOpened("direct:3")
        engine.conversationClosed("direct:3")
        await settle(engine)
        link.clear()
        engine.receive(DeliveryFixtures.echo(DeliveryFixtures.record(id: 60, from: bob, to: alice, text: "Ты тут?")))
        await settle(engine)

        XCTAssertNil(engine.state.visible)
        XCTAssertFalse(link.types().contains("mark_read"), "a closed chat does not read what arrives")
        XCTAssertEqual(engine.state.unread["direct:3"], 1)
    }

    func testClosingAChatThatIsNoLongerVisibleKeepsTheOneThatOpened() async {
        let engine = makeEngine()
        await settle(engine)
        engine.conversationOpened("direct:3")
        engine.conversationOpened("channel:5")
        engine.conversationClosed("direct:3")
        await settle(engine)

        XCTAssertEqual(engine.state.visible, "channel:5")
    }

    // MARK: - Errors for the user

    func testAUserErrorIsPublished() async {
        let engine = makeEngine()
        await settle(engine)

        let outcome = await engine.enqueue(conversation: "direct:3", text: "   ", owner: alice)

        XCTAssertEqual(outcome.userError, "EMPTY_TEXT")
        XCTAssertEqual(engine.lastUserError?.code, "EMPTY_TEXT")
    }
}
