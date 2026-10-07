import Foundation
import XCTest
@testable import CentyChat

/// The server's `DM_NOT_ALLOWED` closes the composer of that direct chat (parity P5, Android's
/// `RefusedDelivery`), until delivery is seen to work again; and a block hides only direct messages
/// (parity P6, `registration.md` §4 «каналы не затрагиваются»).
final class ComposerLockTests: XCTestCase {
    private let chat = "direct:3"

    private func refused(_ key: String, conversation: String = "direct:3", code: String = "DM_NOT_ALLOWED") -> OutboxEntry {
        var entry = OutboxEntry(clientMsgId: key, conversation: conversation, seq: 1, text: "Привет")
        entry.state = OutboxEntry.failed
        entry.failure = DeliveryFailure(reason: DeliveryFailure.rejected, code: code, message: "Сообщение не может быть доставлено")
        return entry
    }

    private func fromPeer(_ id: Int64) -> Message {
        TestModels.message(id: id, from: 3, to: 2)
    }

    func testARefusedSendClosesTheComposer() {
        var refusal = RefusedDelivery(conversation: chat, peer: 3)
        refusal.observe(outbox: [], shown: [fromPeer(10)])
        XCTAssertFalse(refusal.closed)

        refusal.observe(outbox: [refused("k1")], shown: [fromPeer(10)])

        XCTAssertTrue(refusal.closed)
        XCTAssertEqual(ComposerLock.of(blockedByMe: false, refused: refusal.closed), .notDeliverable)
    }

    func testOtherRefusalsAndOtherChatsDoNotCloseIt() {
        var refusal = RefusedDelivery(conversation: chat, peer: 3)
        refusal.observe(outbox: [refused("k1", code: "TEXT_TOO_LONG"), refused("k2", conversation: "direct:4")], shown: [])
        XCTAssertFalse(refusal.closed)
    }

    func testANewerMessageFromThePeerReopensIt() {
        var refusal = RefusedDelivery(conversation: chat, peer: 3)
        refusal.observe(outbox: [refused("k1")], shown: [fromPeer(10)])
        XCTAssertTrue(refusal.closed)

        refusal.observe(outbox: [refused("k1")], shown: [fromPeer(10), fromPeer(11)])
        XCTAssertFalse(refusal.closed, "they may have unblocked me: delivery is worth a try")

        refusal.observe(outbox: [refused("k1"), refused("k2")], shown: [fromPeer(10), fromPeer(11)])
        XCTAssertTrue(refusal.closed, "a new refusal closes it again")
    }

    func testAFreshHistoryOrAnUnblockReopensIt() {
        var refusal = RefusedDelivery(conversation: chat, peer: 3)
        let outbox = [refused("k1")]
        refusal.observe(outbox: outbox, shown: [])
        refusal.reopen(outbox: outbox)
        XCTAssertFalse(refusal.closed)
        refusal.observe(outbox: outbox, shown: [])
        XCTAssertFalse(refusal.closed, "the same refusal does not close it again")
    }

    func testMyOwnBlockComesFirst() {
        XCTAssertEqual(ComposerLock.of(blockedByMe: true, refused: true), .blockedByMe)
        XCTAssertEqual(ComposerLock.of(blockedByMe: false, refused: false), .unlocked)
    }

    func testABlockHidesOnlyDirectMessages() {
        let messages = [
            TestModels.message(id: 1, from: 3, to: 9, type: .channel),
            TestModels.message(id: 2, from: 4, to: 9, type: .channel),
        ]
        let channel = ChatVisibility.messages(messages, in: .channel, isBlocked: { $0 == 3 })
        XCTAssertEqual(channel.map(\.id), [1, 2], "channels are not affected by a block")

        let direct = ChatVisibility.messages([fromPeer(5), TestModels.message(id: 6, from: 2, to: 3)], in: .direct, isBlocked: { $0 == 3 })
        XCTAssertEqual(direct.map(\.id), [6], "the blocked person's direct messages are hidden")
    }
}

/// Sign-out always asks (final review M3, copy-ru.md §1), and the count it shows is the count it
/// deletes: if more became unsent while the question was open, it asks again.
final class SignOutPromptTests: XCTestCase {
    func testTheQuestionIsAskedAgainWhenTheCountChanged() {
        XCTAssertFalse(SignOutPrompt.needsAnotherLook(shown: 0, now: 0))
        XCTAssertFalse(SignOutPrompt.needsAnotherLook(shown: 2, now: 2))
        XCTAssertTrue(SignOutPrompt.needsAnotherLook(shown: 0, now: 1))
        XCTAssertTrue(SignOutPrompt.needsAnotherLook(shown: 2, now: 3))
        XCTAssertTrue(SignOutPrompt.needsAnotherLook(shown: 1, now: nil), "unknown now: say so")
        XCTAssertFalse(SignOutPrompt.needsAnotherLook(shown: 2, now: 0), "fewer is not a surprise: they went out")
    }
}
