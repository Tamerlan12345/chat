import Foundation
import XCTest
@testable import CentyChat

/// Server frames go through the single `RealtimeStore` pump, exactly as the socket delivers them.
@MainActor
final class RealtimeChatTests: XCTestCase {
    private var app: TestApp!

    override func setUp() async throws {
        app = TestApp()
        app.session.currentUser = TestModels.me
    }

    override func tearDown() async throws {
        app = nil
    }

    private var realtime: RealtimeStore { app.container.realtime }
    private var conversations: ConversationsStore { app.container.conversations }

    private func openChat(with userId: Int64, messages: [Message] = []) async -> ChatStore {
        let key = ConversationKey(type: .direct, targetId: userId)
        app.chat.state.withValue { $0.messages[key] = messages }
        let store = app.container.chats.store(for: key)
        await store.load()
        return store
    }

    private func messageJSON(id: Int64, from senderId: Int64, to targetId: Int64, type: String = "direct", text: String = "Привет") -> String {
        """
        {"id":\(id),"conversation_type":"\(type)","target_id":\(targetId),"sender_id":\(senderId),"text":"\(text)","type":"text","created_at":"2026-09-30T09:40:00.000Z","updated_at":null,"is_deleted":0,"sender_name":"Данияр Нурпеисов"}
        """
    }

    // MARK: - Dedupe

    func testDirectMessageAndNewMessageForTheSameIdCountAsOneUnread() {
        conversations.directConversations = [TestModels.direct(with: 12)]
        let message = messageJSON(id: 512, from: 12, to: 1)

        realtime.dispatch(TestModels.event(#"{"type":"direct_message","message":\#(message)}"#))
        realtime.dispatch(TestModels.event(#"{"type":"new_message","message":\#(message)}"#))

        XCTAssertEqual(conversations.directConversations.first?.unreadCount, 1)
    }

    func testChannelMessageAndNewMessageForTheSameIdCountAsOneUnread() {
        conversations.channels = [TestModels.channel(id: 8)]
        let message = messageJSON(id: 513, from: 12, to: 8, type: "channel")

        realtime.dispatch(TestModels.event(#"{"type":"channel_message","message":\#(message)}"#))
        realtime.dispatch(TestModels.event(#"{"type":"new_message","message":\#(message)}"#))

        XCTAssertEqual(conversations.channels.first?.unreadCount, 1)
    }

    func testIncomingPairForADialogThatIsNotOnScreenRaisesUnreadByExactlyOne() async {
        conversations.directConversations = [TestModels.direct(with: 12)]
        let chat = await openChat(with: 12)
        chat.setVisible(true)
        chat.setVisible(false)
        let message = messageJSON(id: 700, from: 12, to: 1)

        realtime.dispatch(TestModels.event(#"{"type":"direct_message","message":\#(message)}"#))
        realtime.dispatch(TestModels.event(#"{"type":"new_message","message":\#(message)}"#))

        XCTAssertEqual(conversations.directConversations.first?.unreadCount, 1)
        await settle()
        let sentTypes = await app.realtime.sentTypes
        XCTAssertFalse(sentTypes.contains("mark_read"), "A dialog that is not on screen must stay unread")
    }

    func testIncomingMessageInTheVisibleChatStaysReadAndIsMarkedRead() async {
        conversations.directConversations = [TestModels.direct(with: 12)]
        let chat = await openChat(with: 12)
        chat.setVisible(true)
        let message = messageJSON(id: 701, from: 12, to: 1)

        realtime.dispatch(TestModels.event(#"{"type":"direct_message","message":\#(message)}"#))
        realtime.dispatch(TestModels.event(#"{"type":"new_message","message":\#(message)}"#))

        XCTAssertEqual(conversations.directConversations.first?.unreadCount, 0)
        let realtimeRepository = app.realtime
        let markedRead = await eventually { await realtimeRepository.sentTypes.contains("mark_read") }
        XCTAssertTrue(markedRead, "The visible chat must send mark_read so the sender sees the message as read")
    }

    // MARK: - Open chat reflects realtime events

    func testIncomingMessageAppearsOnceInTheOpenChat() async {
        let chat = await openChat(with: 12)
        let message = messageJSON(id: 600, from: 12, to: 1)

        realtime.dispatch(TestModels.event(#"{"type":"direct_message","message":\#(message)}"#))
        realtime.dispatch(TestModels.event(#"{"type":"new_message","message":\#(message)}"#))

        XCTAssertEqual(chat.messages.map(\.id), [600])
    }

    func testOwnEchoReplacesTheOptimisticMessage() async {
        let chat = await openChat(with: 12)

        await chat.send(text: "Отправил контракты")
        XCTAssertEqual(chat.messages.count, 1)
        realtime.dispatch(TestModels.event(#"{"type":"new_message","message":\#(messageJSON(id: 601, from: 1, to: 12, text: "Отправил контракты"))}"#))

        XCTAssertEqual(chat.messages.map(\.id), [601])
        XCTAssertEqual(chat.messages.first?.text, "Отправил контракты")
    }

    func testRealtimeEditUpdatesTheOpenChat() async {
        let chat = await openChat(with: 12, messages: [TestModels.message(id: 512, from: 12, to: 1, text: "Старый текст")])

        realtime.dispatch(TestModels.event("""
        {"type":"message_updated","message":{"id":512,"conversation_type":"direct","target_id":1,"sender_id":12,"text":"Новый текст","type":"text","created_at":"2026-09-30T09:40:00.000Z","updated_at":"2026-09-30T09:41:00.000Z","is_deleted":0}}
        """))

        XCTAssertEqual(chat.messages.first?.text, "Новый текст")
        XCTAssertNotNil(chat.messages.first?.updatedAt)
    }

    func testRealtimeDeletionMarksTheMessageDeletedInTheOpenChat() async {
        let chat = await openChat(with: 12, messages: [TestModels.message(id: 512, from: 12, to: 1, text: "Удалю")])

        // targetId is the stored target (me), not relative to the receiver: match by messageId.
        realtime.dispatch(TestModels.event(#"{"type":"message_deleted","messageId":512,"conversationType":"direct","targetId":1}"#))

        XCTAssertEqual(chat.messages.first?.isDeleted, true)
        XCTAssertEqual(chat.messages.first?.text, "")
    }

    func testDeliveryStatusUpdateReachesTheOpenChat() async {
        let chat = await openChat(with: 12, messages: [TestModels.message(id: 512, from: 1, to: 12, deliveryStatus: .sent)])

        realtime.dispatch(TestModels.event(#"{"type":"message_status_updated","messageId":512,"status":"delivered","userId":12,"timestamp":"2026-09-30T09:40:01.000Z"}"#))

        XCTAssertEqual(chat.messages.first?.deliveryStatus, .delivered)
    }

    func testPeerReadReceiptMarksOwnMessagesReadWithoutTouchingMyUnreadCount() async {
        conversations.directConversations = [TestModels.direct(with: 12, unread: 3)]
        let chat = await openChat(with: 12, messages: [TestModels.message(id: 512, from: 1, to: 12, deliveryStatus: .delivered)])
        conversations.directConversations[0].unreadCount = 3

        realtime.dispatch(TestModels.event(#"{"type":"messages_read","byUserId":12,"messageIds":[512]}"#))

        XCTAssertEqual(chat.messages.first?.deliveryStatus, .read)
        XCTAssertEqual(conversations.directConversations.first?.unreadCount, 3)
    }

    func testDirectTypingIsShownInTheDialogWithTheTypist() {
        // For direct dialogs the server sends targetId = recipient (me); the dialog is keyed by the typist.
        realtime.dispatch(TestModels.event(#"{"type":"user_typing","userId":12,"userName":"Данияр","conversationType":"direct","targetId":1,"isTyping":true}"#))

        let key = ConversationsStore.typingKey(for: ConversationKey(type: .direct, targetId: 12))
        XCTAssertNotNil(conversations.typingUsers[key])
    }

    func testCallEndWithoutTargetAfterConnectionLossIsParsed() {
        let event = WSServerEvent.parse(from: Data(#"{"type":"call_end","senderId":12,"senderName":"Данияр","reason":"connection_lost"}"#.utf8))

        guard case .callEnd(_, let senderId, _, let reason)? = event else {
            return XCTFail("call_end without targetUserId must still end the call, got \(String(describing: event))")
        }
        XCTAssertEqual(senderId, 12)
        XCTAssertEqual(reason, "connection_lost")
    }
}
