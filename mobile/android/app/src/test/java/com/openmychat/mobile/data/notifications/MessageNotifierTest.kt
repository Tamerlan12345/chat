package com.openmychat.mobile.data.notifications

import com.openmychat.mobile.core.network.AuthContext
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.User
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.data.realtime.ConversationRef
import com.openmychat.mobile.data.realtime.PresenceController
import com.openmychat.mobile.testing.FakeRealtimeRepository
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/** Уведомления по решению сервера (notify), снятие по conversation_read и push read (чек-лист §10). */
@OptIn(ExperimentalCoroutinesApi::class)
class MessageNotifierTest {

    private class RecordingSink : NotificationSink {
        val log = mutableListOf<String>()
        override fun show(conversation: ConversationRef, title: String, text: String, chatTitle: String) {
            log += "show ${conversation.type.value}-${conversation.targetId} $title: $text"
        }
        override fun cancel(conversation: ConversationRef) {
            log += "cancel ${conversation.type.value}-${conversation.targetId}"
        }
    }

    private val realtime = FakeRealtimeRepository()
    private val sink = RecordingSink()
    private val bus = ConversationReadBus()
    private val registry = ActiveConversationRegistry()
    private val me = User(id = 1, username = "me", fullName = "Я")
    private val chat5 = ConversationRef(ConversationType.DIRECT, 5)

    private lateinit var presence: PresenceController

    private fun TestScope.notifier(): MessageNotifier {
        presence = PresenceController(realtime, backgroundScope, registry, AuthContext())
        return MessageNotifier(realtime, sink, bus, registry, presence, backgroundScope).also {
            runCurrent()
            realtime.emit(WsEvent.AuthSuccess(me))
            runCurrent()
            sink.log.clear()
        }
    }

    private fun incoming(id: Long, from: Long = 5, text: String = "привет") =
        Message(id = id, targetId = 1, senderId = from, text = text, createdAt = "2026-10-02T09:00:00Z", senderName = "Иванов")

    @Test
    fun aBannerOnlyWhenTheServerSaysNotify() = runTest {
        notifier()
        realtime.emit(WsEvent.NewMessage(incoming(10), notify = false))
        realtime.emit(WsEvent.NewMessage(incoming(11, text = "второе"), notify = true))
        runCurrent()
        assertEquals(listOf("show direct-5 Иванов: второе"), sink.log)
    }

    @Test
    fun withoutTheFieldTheOldLocalRuleDecides() = runTest {
        val n = notifier()
        presence.onForeground()
        realtime.emit(WsEvent.NewMessage(incoming(10), notify = null))
        runCurrent()
        // Свои — никогда; открытая здесь переписка — нет; «Не беспокоить» — нет.
        realtime.emit(WsEvent.NewMessage(incoming(11, from = 1), notify = null))
        registry.enter(chat5)
        runCurrent()
        sink.log.clear()
        realtime.emit(WsEvent.NewMessage(incoming(12), notify = null))
        runCurrent() // кадр обработан, пока переписка ещё открыта
        registry.leave(chat5)
        realtime.emit(WsEvent.UserStatusChanged(1, UserStatus.DND, null))
        realtime.emit(WsEvent.NewMessage(incoming(13), notify = null))
        runCurrent()
        assertEquals(emptyList<String>(), sink.log)
        n.hashCode()
    }

    @Test
    fun theFirstLocalRuleMessageIsShown() = runTest {
        notifier()
        realtime.emit(WsEvent.NewMessage(incoming(10), notify = null))
        runCurrent()
        assertEquals(listOf("show direct-5 Иванов: привет"), sink.log)
    }

    @Test
    fun readOnAnotherDeviceDismissesAndResetsTheCounter() = runTest {
        notifier()
        val reads = mutableListOf<ConversationRef>()
        backgroundScope.launch { bus.reads.collect { reads += it } }
        runCurrent()
        realtime.emit(WsEvent.ConversationRead(ConversationType.CHANNEL, 7, byUserId = 1, at = "", lastReadId = 120))
        runCurrent()
        assertEquals(listOf("cancel channel-7"), sink.log)
        assertEquals(listOf(ConversationRef(ConversationType.CHANNEL, 7)), reads)
    }

    @Test
    fun silentReadPushDismissesAndShowsNothing() = runTest {
        val n = notifier()
        val reads = mutableListOf<ConversationRef>()
        backgroundScope.launch { bus.reads.collect { reads += it } }
        runCurrent()
        n.onPush(mapOf("type" to "read", "conversationType" to "direct", "targetId" to "5"))
        runCurrent()
        assertEquals(listOf("cancel direct-5"), sink.log)
        assertEquals(listOf(chat5), reads)
    }

    @Test
    fun aMessagePushIsDroppedWhenAlreadyKnownOrTheChatIsOpen() = runTest {
        val n = notifier()
        realtime.emit(WsEvent.NewMessage(incoming(10), notify = false))
        runCurrent()
        n.onPush(mapOf("type" to "message", "conversationType" to "direct", "targetId" to "5", "messageId" to "10"))
        presence.onForeground()
        registry.enter(chat5)
        runCurrent()
        sink.log.clear()
        n.onPush(mapOf("type" to "message", "conversationType" to "direct", "targetId" to "5", "messageId" to "11"))
        registry.leave(chat5)
        n.onPush(mapOf("type" to "message", "conversationType" to "direct", "targetId" to "5", "messageId" to "12"))
        assertEquals(listOf("show direct-5 CentyChat: Новое сообщение"), sink.log)
    }

    @Test
    fun openingTheChatHereDismissesItsNotification() = runTest {
        notifier()
        registry.enter(chat5)
        runCurrent()
        assertEquals(listOf("cancel direct-5"), sink.log)
    }

    @Test
    fun pushPayloadsOutsideTheContractAreIgnored() {
        assertEquals(null, PushPayload.parse(mapOf("type" to "read", "conversationType" to "group", "targetId" to "5")))
        assertEquals(null, PushPayload.parse(mapOf("type" to "message", "conversationType" to "direct", "targetId" to "5")))
        assertEquals(null, PushPayload.parse(mapOf("type" to "unknown")))
    }
}
