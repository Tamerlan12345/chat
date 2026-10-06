import Foundation
import XCTest
@testable import CentyChat

/// What the chat shows (`delivery-state.md` §3.4) and where a bubble shows its time and state.
@MainActor
final class ChatProjectionTests: XCTestCase {
    private let me: Int64 = 2
    private let peer: Int64 = 3

    private func record(_ id: Int64, from sender: Int64, text: String = "текст", key: String? = nil, replyTo: Int64? = nil, status: String? = nil) -> Msg {
        var json = DeliveryFixtures.record(id: id, from: sender, to: sender == me ? peer : me, text: text, clientMsgId: key)
        json["reply_to_id"] = .orNull(replyTo)
        let own = sender == me
        return DeliveryReducer.project(json, status: own ? (status ?? "sent") : nil)
    }

    private func entry(_ key: String, seq: Int64, text: String, state: String = OutboxEntry.queued) -> OutboxEntry {
        var entry = OutboxEntry(clientMsgId: key, conversation: "direct:3", seq: seq, text: text)
        entry.state = state
        return entry
    }

    private func build(_ state: DeliveryState, uploads: [AttachmentUploads.Item] = [], handedOver: [String: PendingUpload] = [:], user: Int64? = nil) -> [Message] {
        ChatProjection(conversationType: .direct, targetId: peer).build(
            state: state,
            me: user ?? me,
            myName: "Алиса",
            uploads: uploads,
            handedOver: handedOver,
            fileURL: { URL(fileURLWithPath: "/tmp/\($0)") }
        )
    }

    func testServerMessagesComeFirstThenTheQueueInItsOrder() async {
        var state = DeliveryState(me: me)
        state.messages["direct:3"] = [record(10, from: peer), record(11, from: me, key: "k-sent")]
        state.outbox = [entry("k-2", seq: 2, text: "второе"), entry("k-1", seq: 1, text: "первое")].sorted { $0.seq < $1.seq }

        let shown = build(state)

        XCTAssertEqual(shown.map(\.text), ["текст", "текст", "первое", "второе"])
        XCTAssertEqual(shown.map(\.sendState), [nil, nil, .queued, .queued])
        XCTAssertEqual(shown[1].deliveryStatus, .sent)
    }

    func testAMessageBeingDeletedAndACancelledEntryAreHidden() async {
        var state = DeliveryState(me: me)
        state.messages["direct:3"] = [record(10, from: me), record(11, from: me)]
        state.ops = [DeliveryOp(op: DeliveryOp.delete, messageId: 10, text: nil)]
        var cancelled = entry("k-x", seq: 1, text: "отменено")
        cancelled.pendingDelete = true
        state.outbox = [cancelled, entry("k-y", seq: 2, text: "останется")]

        XCTAssertEqual(build(state).map(\.rowID), ["id:11", "key:k-y"])
    }

    func testAnEditOfAnUnsentMessageShowsAtOnce() async {
        var state = DeliveryState(me: me)
        var sending = entry("k-1", seq: 1, text: "старый", state: OutboxEntry.sending)
        sending.pendingEdit = "новый"
        state.outbox = [sending]

        XCTAssertEqual(build(state).first?.text, "новый")
        XCTAssertEqual(build(state).first?.sendState, .sending)
    }

    func testAFailedMessageSaysWhyInTheServersWords() async {
        var state = DeliveryState(me: me)
        var failed = entry("k-1", seq: 1, text: "не дошло", state: OutboxEntry.failed)
        failed.failure = DeliveryFailure(reason: DeliveryFailure.rejected, code: "DM_NOT_ALLOWED", message: "Пользователь ограничил личные сообщения")
        var spent = entry("k-2", seq: 2, text: "таймаут", state: OutboxEntry.failed)
        spent.failure = DeliveryFailure(reason: DeliveryFailure.maxAttempts, code: nil, message: nil)
        state.outbox = [failed, spent]

        let shown = build(state)
        XCTAssertEqual(shown.map(\.sendState), [.failed, .failed])
        XCTAssertEqual(shown[0].failureReason, "Пользователь ограничил личные сообщения")
        XCTAssertEqual(shown[1].failureReason, "Сервер не ответил")
    }

    func testTheRowKeepsItsIdentityWhenTheServerConfirmsIt() async {
        var state = DeliveryState(me: me)
        state.outbox = [entry("k-1", seq: 1, text: "привет")]
        let before = build(state).first?.rowID

        state.outbox = []
        state.messages["direct:3"] = [record(20, from: me, text: "привет", key: "k-1")]
        let after = build(state).first?.rowID

        XCTAssertEqual(before, "key:k-1")
        XCTAssertEqual(after, before, "the bubble does not jump")
    }

    func testAnotherAccountsMessagesAreNeverShown() async {
        var state = DeliveryState(me: 9)
        state.messages["direct:3"] = [record(10, from: peer)]
        state.outbox = [entry("k-1", seq: 1, text: "чужое")]

        XCTAssertTrue(build(state).isEmpty)
    }

    func testAReplyShowsItsOriginal() async {
        var state = DeliveryState(me: me)
        state.messages["direct:3"] = [record(10, from: peer, text: "Когда отчёт?")]
        var reply = entry("k-1", seq: 1, text: "Сегодня")
        reply.replyToId = 10
        state.outbox = [reply]

        let shown = build(state)
        XCTAssertEqual(shown.last?.replyQuote?.text, "Когда отчёт?")
        XCTAssertEqual(shown.last?.replyToId, 10)
    }

    func testAFileStillGoingUpIsShownFromItsLocalCopy() async {
        let pending = PendingUpload(clientMsgId: "k-f", conversation: "direct:3", owner: me, createdAt: 1_000, name: "Схема.png", size: 10, mimeType: "image/png", localPath: "k-f/Схема.png", replyToId: nil)
        let other = PendingUpload(clientMsgId: "k-o", conversation: "direct:7", owner: me, createdAt: 1_000, name: "Чужой.pdf", size: 10, mimeType: nil, localPath: "k-o/Чужой.pdf", replyToId: nil)

        let shown = build(DeliveryState(me: me), uploads: [AttachmentUploads.Item(pending: pending, progress: 0.4), AttachmentUploads.Item(pending: other)])

        XCTAssertEqual(shown.count, 1)
        XCTAssertEqual(shown[0].type, .image)
        XCTAssertEqual(shown[0].text, "Схема.png")
        XCTAssertEqual(shown[0].sendState, .sending)
        XCTAssertEqual(shown[0].localUpload?.progress, 0.4)
        XCTAssertEqual(shown[0].localUpload?.fileURL.lastPathComponent, "Схема.png")
    }

    func testAnUploadedFileInTheQueueKeepsDrawingItsLocalCopy() async {
        var state = DeliveryState(me: me)
        var file = entry("k-f", seq: 1, text: "Акт.pdf")
        file.msgType = "file"
        file.metadata = AttachmentRules.metadata(fileId: 5, size: 10, mimeType: "application/pdf", width: nil, height: nil)
        state.outbox = [file]
        let pending = PendingUpload(clientMsgId: "k-f", conversation: "direct:3", owner: me, createdAt: 1_000, name: "Акт.pdf", size: 10, mimeType: "application/pdf", localPath: "k-f/Акт.pdf", replyToId: nil)

        let shown = build(state, handedOver: ["k-f": pending])

        XCTAssertEqual(shown.first?.type, .file)
        XCTAssertEqual(shown.first?.localUpload?.fileURL.lastPathComponent, "Акт.pdf")
        XCTAssertEqual(shown.first?.pendingMetadata?["file_id"], 5)
    }
}

/// Grouping and where the time and state are shown (desktop ChatView: a new group after 5 minutes,
/// another sender or another day).
final class ChatTimelineTests: XCTestCase {
    private let base = Date(timeIntervalSince1970: 1_791_200_000)

    private func message(_ id: Int64, from sender: Int64 = 2, minute: Double = 0, state: SendState? = nil, status: DeliveryStatus? = .sent, edited: Bool = false) -> Message {
        Message(
            id: id,
            conversationType: .direct,
            targetId: 3,
            senderId: sender,
            text: "m\(id)",
            createdAt: base.addingTimeInterval(minute * 60),
            updatedAt: edited ? base : nil,
            senderName: "Алиса",
            deliveryStatus: state == nil ? status : nil,
            clientMsgId: state == nil ? nil : "k\(id)",
            sendState: state
        )
    }

    private func meta(_ messages: [Message]) -> [Bool] {
        ChatTimeline.rows(messages, me: 2, timeZone: TimeZone(identifier: "Asia/Almaty")!).map(\.showsMeta)
    }

    func testOnlyTheLastBubbleOfAGroupShowsItsTimeAndState() {
        XCTAssertEqual(meta([message(1), message(2, minute: 1), message(3, minute: 2)]), [false, false, true])
    }

    func testAnotherSenderOrFiveMinutesStartAGroup() {
        XCTAssertEqual(meta([message(1), message(2, from: 3, minute: 1), message(3, from: 3, minute: 7)]), [true, true, true])
    }

    func testAnEditedBubbleShowsItsMeta() {
        XCTAssertEqual(meta([message(1, edited: true), message(2, minute: 1)]), [true, true])
    }

    func testAStalledQueuedBubbleBehindASentOneShowsItsClock() {
        // Out of order: an earlier message still waits while a later one of its group got through.
        XCTAssertEqual(meta([message(1, state: .queued), message(2, minute: 1)]), [true, true])
        XCTAssertEqual(meta([message(1, state: .sending), message(2, minute: 1, state: .failed)]), [true, true])
    }

    func testAQueueWaitingInOrderShowsOneClockAtItsEnd() {
        // FIFO: the first is on its way, the rest wait behind it — nothing is out of order.
        XCTAssertEqual(meta([message(1, state: .sending), message(2, minute: 1, state: .queued), message(3, minute: 1, state: .queued)]), [false, false, true])
    }

    func testADeliveryStatusCatchingUpNeverReflowsHistory() {
        XCTAssertEqual(meta([message(1, status: .sent), message(2, minute: 1, status: .read)]), [false, true])
    }

    func testADayStartsAGroupAndGetsItsSeparator() {
        let rows = ChatTimeline.rows([message(1), message(2, minute: 60 * 24)], me: 2, timeZone: TimeZone(identifier: "Asia/Almaty")!)
        XCTAssertEqual(rows.map(\.showsMeta), [true, true])
        XCTAssertEqual(rows.map(\.startsDay), [true, true])
    }
}

/// Whose things the chat shows, and what the composer keeps.
@MainActor
final class ChatOwnershipProjectionTests: XCTestCase {
    private func build(_ state: DeliveryState, uploads: [AttachmentUploads.Item]) -> [Message] {
        ChatProjection(conversationType: .direct, targetId: 3).build(
            state: state, me: 2, myName: "Алиса", uploads: uploads, handedOver: [:], fileURL: { URL(fileURLWithPath: "/tmp/\($0)") }
        )
    }

    private func upload(owner: Int64) -> AttachmentUploads.Item {
        AttachmentUploads.Item(pending: PendingUpload(clientMsgId: "k-\(owner)", conversation: "direct:3", owner: owner, createdAt: 1, name: "f\(owner).pdf", size: 1, mimeType: nil, localPath: "k/f.pdf", replyToId: nil))
    }

    func testAnotherAccountsWaitingFileIsNeverShown() async {
        let shown = build(DeliveryState(me: 2), uploads: [upload(owner: 4), upload(owner: 2)])
        XCTAssertEqual(shown.map(\.text), ["f2.pdf"])
    }

    func testAModelThatNamesNoAccountShowsNothing() async {
        var state = DeliveryState()
        state.outbox = [OutboxEntry(clientMsgId: "k-x", conversation: "direct:3", seq: 1, text: "чьё?")]
        XCTAssertTrue(build(state, uploads: [upload(owner: 2)]).isEmpty)
    }

    func testTheComposerKeepsWhatWasTypedWhileTheMessageWasBeingStored() async {
        XCTAssertEqual(ComposerText.afterSend(sent: "Привет", current: "Привет"), "")
        XCTAssertEqual(ComposerText.afterSend(sent: "Привет", current: "Привет, как дела"), "Привет, как дела")
    }
}
