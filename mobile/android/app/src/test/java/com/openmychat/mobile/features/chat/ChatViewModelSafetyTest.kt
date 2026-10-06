package com.openmychat.mobile.features.chat

import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.BlockedUser
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.ReportTargetType
import com.openmychat.mobile.data.model.SendState
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.features.account.ReportTarget
import com.openmychat.mobile.testing.FakeAccountRepository
import com.openmychat.mobile.testing.DeliveryHarness
import com.openmychat.mobile.testing.FakeChatRepository
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.FakeSessionRepository
import com.openmychat.mobile.testing.FakeSessionRepository.Companion.ME
import com.openmychat.mobile.testing.MainDispatcherRule
import com.openmychat.mobile.testing.message
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Blocks and reports in a chat (contracts/registration.md §4). */
class ChatViewModelSafetyTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    private val alice = 7L
    private val realtime = FakeRealtimeRepository()
    private val chat = FakeChatRepository(history = listOf(message(id = 10, from = 7, to = ME, text = "Привет")))
    private val account = FakeAccountRepository()
    private val delivery = DeliveryHarness(realtime, chat, mainDispatcher.dispatcher)

    private fun open(type: ConversationType = ConversationType.DIRECT, target: Long = alice) = ChatViewModel(
        conversationType = type,
        targetId = target,
        chatRepository = chat,
        realtimeRepository = realtime,
        sessionRepository = FakeSessionRepository(),
        activeConversations = ActiveConversationRegistry(),
        delivery = delivery.engine,
        sends = delivery.sends,
        account = account
    )

    private val ChatViewModel.shown get() = (uiState.value as ChatUiState.Content).messages

    @Test
    fun theServersDmNotAllowedClosesTheComposer() {
        val vm = open()
        vm.sendMessage("привет")
        val local = vm.shown.last()

        realtime.emit(
            WsEvent.GenericError("send_message", "Сообщение не может быть доставлено", "привет", local.clientMsgId, code = "DM_NOT_ALLOWED")
        )

        assertEquals(ComposerLock.NOT_DELIVERABLE, vm.composerLock.value)
        assertEquals(SendState.FAILED, vm.shown.last().sendState)

        realtime.sent.clear()
        vm.sendMessage("ещё раз")
        assertTrue("nothing is sent while the chat is closed", realtime.sent.none { it.startsWith("send_message") })
    }

    @Test
    fun otherRefusalsLeaveTheComposerOpen() {
        val vm = open()
        vm.sendMessage("привет")

        realtime.emit(WsEvent.GenericError("send_message", "Ошибка", "привет", vm.shown.last().clientMsgId, code = "INTERNAL_ERROR"))

        assertEquals(ComposerLock.NONE, vm.composerLock.value)
    }

    @Test
    fun aBlockedPeerLocksTheComposerUntilUnblocked() {
        account.blocked.value = listOf(BlockedUser(alice, "Алиса"))
        val vm = open()
        assertEquals(ComposerLock.BLOCKED_BY_ME, vm.composerLock.value)

        vm.unblock()

        assertEquals(listOf("unblock 7"), account.blockCalls)
        assertEquals(ComposerLock.NONE, vm.composerLock.value)
    }

    @Test
    fun aBlockMadeElsewhereClosesTheComposerOnceTheSessionsListArrives() {
        val vm = open()
        assertEquals(ComposerLock.NONE, vm.composerLock.value)

        // The sign-in's block list load returns a block made on another device.
        account.blocked.value = listOf(BlockedUser(alice, "Алиса"))

        assertEquals(ComposerLock.BLOCKED_BY_ME, vm.composerLock.value)
        assertTrue(vm.blocks!!.blocked.value)
    }

    @Test
    fun blockingFromTheChatLocksItAndReloadsTheHistory() {
        val vm = open()
        chat.history = emptyList() // the server now hides the blocked person's messages

        vm.block("Алиса")

        assertEquals(listOf("block 7"), account.blockCalls)
        assertEquals(ComposerLock.BLOCKED_BY_ME, vm.composerLock.value)
        assertEquals(emptyList<Any>(), vm.shown)
    }

    @Test
    fun aMessageAndThePersonCanBeReported() {
        val vm = open()
        val incoming = vm.shown.single().copy(senderName = "Алиса")

        assertTrue(vm.canReportMessage(incoming))
        vm.reportMessage(incoming)
        assertEquals(ReportTarget(ReportTargetType.MESSAGE, 10, "Алиса: Привет"), vm.reports.sheet.value?.target)

        vm.reports.dismiss()
        vm.reportPeer("Алиса")
        assertEquals(ReportTarget(ReportTargetType.USER, alice, "Алиса"), vm.reports.sheet.value?.target)
    }

    @Test
    fun ownAndUnsentMessagesAreNotReported() {
        val vm = open()
        vm.sendMessage("моё")

        assertTrue(!vm.canReportMessage(vm.shown.last()))
        assertTrue(!vm.canReportMessage(message(id = 11, from = ME, to = alice)))
    }

    @Test
    fun channelsHaveNoPersonToBlock() {
        account.blocked.value = listOf(BlockedUser(5, "Канал?"))
        val vm = open(type = ConversationType.CHANNEL, target = 5)

        assertEquals(ComposerLock.NONE, vm.composerLock.value)
        assertNull(vm.blocks)
    }

    private fun refuse(vm: ChatViewModel, text: String) {
        vm.sendMessage(text)
        val local = vm.shown.last()
        realtime.emit(WsEvent.GenericError("send_message", "Сообщение не может быть доставлено", text, local.clientMsgId, code = "DM_NOT_ALLOWED"))
    }

    @Test
    fun aSuccessfulHistoryReloadReopensARefusedChat() {
        val vm = open()
        refuse(vm, "привет")
        assertEquals(ComposerLock.NOT_DELIVERABLE, vm.composerLock.value)

        vm.loadMessages() // e.g. after a reconnect: the server answers this conversation again

        assertEquals(ComposerLock.NONE, vm.composerLock.value)
        realtime.sent.clear()
        vm.sendMessage("ещё раз")
        assertTrue("sending works again", realtime.sent.any { it.startsWith("send_message") })
    }

    @Test
    fun aMessageFromThePeerReopensARefusedChat() {
        val vm = open()
        refuse(vm, "привет")

        realtime.emit(WsEvent.NewMessage(message(id = 20, from = alice, to = ME, text = "Я вас разблокировала")))

        assertEquals(ComposerLock.NONE, vm.composerLock.value)
    }

    @Test
    fun aNewRefusalAfterReopeningClosesTheChatAgain() {
        val vm = open()
        refuse(vm, "привет")
        vm.loadMessages()
        assertEquals(ComposerLock.NONE, vm.composerLock.value)

        refuse(vm, "снова")

        assertEquals(ComposerLock.NOT_DELIVERABLE, vm.composerLock.value)
    }

    @Test
    fun myOwnEchoDoesNotReopenARefusedChat() {
        val vm = open()
        refuse(vm, "привет")

        realtime.emit(WsEvent.NewMessage(message(id = 21, from = ME, to = alice, text = "с другого устройства")))

        assertEquals(ComposerLock.NOT_DELIVERABLE, vm.composerLock.value)
    }
}
