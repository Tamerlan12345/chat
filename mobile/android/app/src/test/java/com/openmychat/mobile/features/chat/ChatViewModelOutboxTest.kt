package com.openmychat.mobile.features.chat

import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.SendState
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.data.repository.PickedFile
import com.openmychat.mobile.testing.DeliveryHarness
import com.openmychat.mobile.testing.FakeAttachmentRepository
import com.openmychat.mobile.testing.FakeChatRepository
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.FakeSessionRepository
import com.openmychat.mobile.testing.FakeSessionRepository.Companion.ME
import com.openmychat.mobile.testing.MainDispatcherRule
import com.openmychat.mobile.testing.message
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * The chat on the durable delivery core (delivery-state.md): FIFO per conversation, the composer
 * cleared only after the durable enqueue, «Ответить» as `reply_to_id`, edit and delete as ops,
 * older pages by `beforeId`, and a file waiting (not failing) on a transport error.
 */
class ChatViewModelOutboxTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    private val alice = 7L
    private val realtime = FakeRealtimeRepository()
    private val chat = FakeChatRepository()
    private val files = FakeAttachmentRepository()
    private val delivery = DeliveryHarness(realtime, chat, mainDispatcher.dispatcher, files = files)
    private val notices = mutableListOf<String>()

    private fun directChat() = ChatViewModel(
        conversationType = ConversationType.DIRECT,
        targetId = alice,
        chatRepository = chat,
        realtimeRepository = realtime,
        sessionRepository = FakeSessionRepository(),
        activeConversations = ActiveConversationRegistry(),
        delivery = delivery.engine,
        sends = delivery.sends,
        attachments = files
    ).also { vm -> CoroutineScope(mainDispatcher.dispatcher).launch { vm.notices.collect { notices += it } } }

    private val ChatViewModel.shown get() = (uiState.value as ChatUiState.Content).messages

    private fun echo(local: Message, id: Long) = WsEvent.NewMessage(
        message(id = id, from = ME, to = alice, text = local.text).copy(clientMsgId = local.clientMsgId)
    )

    private fun elapse(ms: Long) {
        mainDispatcher.dispatcher.scheduler.advanceTimeBy(ms)
        mainDispatcher.dispatcher.scheduler.runCurrent()
    }

    private val textFrames get() = realtime.frames.filter { (it["type"] as JsonPrimitive).content == "send_message" }

    @Test
    fun queuedMessagesGoOutOneAtATimeInTheOrderTheyWereWritten() {
        realtime.connectionState.value = ConnectionState.Connecting
        val vm = directChat()
        vm.sendMessage("первое")
        vm.sendMessage("второе")
        vm.sendMessage("третье")
        assertEquals(listOf("первое", "второе", "третье"), vm.shown.map { it.text })

        realtime.connectionState.value = ConnectionState.Connected

        // Stop-and-wait (§7.2): the next one leaves only once the server has the one before it.
        assertEquals(listOf("send_message direct 7 первое"), realtime.sent.filter { it.startsWith("send_message") })
        assertEquals(listOf(SendState.SENDING, SendState.QUEUED, SendState.QUEUED), vm.shown.map { it.sendState })
        realtime.emit(echo(vm.shown[0], id = 101))
        realtime.emit(echo(vm.shown[1], id = 102))
        realtime.emit(echo(vm.shown[2], id = 103))

        assertEquals(
            listOf("send_message direct 7 первое", "send_message direct 7 второе", "send_message direct 7 третье"),
            realtime.sent.filter { it.startsWith("send_message") }
        )
        assertEquals(listOf(101L, 102L, 103L), vm.shown.map { it.id })
    }

    @Test
    fun aStalledFirstMessageHoldsTheOthersBackAndStaysVisible() {
        val vm = directChat()
        vm.sendMessage("первое")
        vm.sendMessage("второе")

        elapse(10_500) // the first one timed out and waits before it goes again

        assertEquals(listOf("send_message direct 7 первое"), realtime.sent.filter { it.startsWith("send_message") })
        val items = buildChatItems(vm.shown, ME, markOverride = ::sendStateMark).filterIsInstance<ChatItem.Bubble>()
        assertEquals(listOf(SendState.QUEUED, SendState.QUEUED), items.map { it.message.sendState })
        assertTrue("the last bubble shows the queue's clock", items.last().showsMeta)
    }

    @Test
    fun theComposerClearsOnlyOnceTheMessageIsStored() {
        val vm = directChat()
        var cleared = 0
        delivery.store.failNextPersist = java.io.IOException("disk full")

        vm.send("не сохранилось", replyTo = null) { cleared++ }

        assertEquals("the text stays in the composer", 0, cleared)
        assertEquals(listOf("Сообщение не сохранено — попробуйте ещё раз"), notices)
        assertTrue(vm.shown.isEmpty())

        vm.send("сохранилось", replyTo = null) { cleared++ }
        assertEquals(1, cleared)
        assertEquals(1, vm.shown.size)
    }

    @Test
    fun aReplySendsReplyToIdAndShowsTheQuote() {
        chat.history = listOf(message(id = 40, from = alice, to = ME, text = "Вопрос по отчёту"))
        val vm = directChat()
        val original = vm.shown.single()

        vm.send("Ответ", replyTo = original) {}

        val frame = textFrames.single()
        assertEquals(40L, frame["replyToId"]!!.jsonPrimitive.long)
        val reply = vm.shown.last()
        assertEquals(40L, reply.replyToId)
        assertEquals("Вопрос по отчёту", reply.metadata?.replyText)
    }

    @Test
    fun aReplyToAMessageNotYetOnTheServerSendsNoReplyId() {
        realtime.connectionState.value = ConnectionState.Connecting
        val vm = directChat()
        vm.sendMessage("ещё не ушло")
        val unsent = vm.shown.single()
        realtime.connectionState.value = ConnectionState.Connected

        vm.send("ответ", replyTo = unsent) {}
        realtime.emit(echo(unsent, id = 200))

        assertEquals(JsonNull, textFrames.last()["replyToId"])
    }

    @Test
    fun aFileAnsweringAMessageCarriesReplyToId() {
        chat.history = listOf(message(id = 41, from = alice, to = ME, text = "Пришлите файл"))
        val pdf = PickedFile("content://docs/1", "отчёт.pdf", 2048, "application/pdf")
        files.picked[pdf.uri] = pdf
        val vm = directChat()

        vm.sendAttachment(pdf.uri, replyTo = vm.shown.single())

        assertEquals(41L, textFrames.single()["replyToId"]!!.jsonPrimitive.long)
    }

    @Test
    fun anEditGoesAsAnOpAndTheTextChangesWhenTheServerSaysSo() {
        chat.history = listOf(message(id = 50, from = ME, to = alice, text = "было").copy(createdAt = java.time.Instant.now().toString()))
        val vm = directChat()
        vm.startEditing(vm.shown.single())
        var cleared = 0

        vm.send("стало", replyTo = null) { cleared++ }

        assertEquals(1, cleared)
        assertEquals(listOf("edit_message 50"), realtime.sent.filter { it.startsWith("edit_message") })
        assertEquals("unchanged until message_updated", "было", vm.shown.single().text)
        assertEquals(null, vm.editingMessage.value)
    }

    @Test
    fun deletingAnOwnMessageHidesItAtOnceAndTheTombstoneShowsItDeleted() {
        chat.history = listOf(message(id = 60, from = ME, to = alice, text = "удалю"))
        val vm = directChat()

        vm.deleteMessage(vm.shown.single())

        assertTrue("hidden while the delete is on its way (§3.4)", vm.shown.isEmpty())
        assertEquals(listOf("delete_message 60"), realtime.sent.filter { it.startsWith("delete_message") })
        realtime.emit(WsEvent.MessageDeleted(messageId = 60, conversationType = "direct", targetId = alice))
        assertTrue(vm.shown.single().isDeleted)
    }

    @Test
    fun cancellingAQueuedMessageNeverSendsIt() {
        realtime.connectionState.value = ConnectionState.Connecting
        val vm = directChat()
        vm.sendMessage("передумал")

        vm.cancelUnsent(vm.shown.single())
        realtime.connectionState.value = ConnectionState.Connected

        assertTrue(vm.shown.isEmpty())
        assertTrue(realtime.sent.none { it.startsWith("send_message") })
    }

    @Test
    fun scrollingUpLoadsTheOlderPageBeforeTheOldestMessage() {
        chat.history = (51L..100L).map { message(it, from = alice, to = ME) }
        chat.older = mapOf(51L to (1L..50L).map { message(it, from = alice, to = ME) }, 1L to emptyList())
        val vm = directChat()

        vm.loadOlder()
        assertEquals((1L..100L).toList(), vm.shown.map { it.id })
        vm.loadOlder()
        vm.loadOlder()

        assertEquals("one page per reach, none past the start", listOf(51L, 1L), chat.olderRequests)
    }

    @Test
    fun aTransportFailureLeavesAFileQueuedEvenWhileTheSocketIsUp() {
        val pdf = PickedFile("content://docs/1", "отчёт.pdf", 2048, "application/pdf")
        files.picked[pdf.uri] = pdf
        files.uploadFailure = ApiException(0, "NETWORK_ERROR", "timeout")
        val vm = directChat()

        vm.sendAttachment(pdf.uri)

        assertEquals("not refused: it waits", SendState.QUEUED, vm.shown.single().sendState)
        assertTrue(notices.isEmpty())
        elapse(16_000)
        assertEquals("it went again by itself", 2, files.uploads.size)
        assertEquals(1, textFrames.size)
    }

    @Test
    fun aFileIsKeptBeforeItIsQueuedSoItSurvivesTheProcess() {
        val pdf = PickedFile("content://docs/1", "отчёт.pdf", 2048, "application/pdf")
        files.picked[pdf.uri] = pdf
        realtime.connectionState.value = ConnectionState.Connecting
        val vm = directChat()

        vm.sendAttachment(pdf.uri)

        val key = vm.shown.single().clientMsgId!!
        assertEquals(listOf(key), files.kept)
        assertFalse(files.uploads.isNotEmpty())
    }
}
