package com.openmychat.mobile.features.chat

import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.FilePolicy
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.MessageType
import com.openmychat.mobile.data.model.SendState
import com.openmychat.mobile.data.model.RolePermissions
import com.openmychat.mobile.data.realtime.ActiveConversationRegistry
import com.openmychat.mobile.data.repository.PickedFile
import com.openmychat.mobile.features.attachments.TransferState
import java.io.File
import com.openmychat.mobile.testing.FakeAttachmentRepository
import com.openmychat.mobile.testing.FakeChatRepository
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.FakeSessionRepository
import com.openmychat.mobile.testing.FakeSessionRepository.Companion.ME
import com.openmychat.mobile.testing.MainDispatcherRule
import com.openmychat.mobile.testing.message
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * QA D4: a file is sent from Android like a text message — on screen at once, uploaded with progress
 * (cancellable), then sent as a `file`/`image` message whose text is the file name (as the desktop
 * does), queued offline, failed with the server's reason, retried.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatViewModelAttachmentTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    private val alice = 7L
    private val realtime = FakeRealtimeRepository()
    private val chat = FakeChatRepository()
    private val files = FakeAttachmentRepository()
    private val notices = mutableListOf<String>()

    private val pdf = PickedFile("content://docs/1", "отчёт.pdf", 2048, "application/pdf")
    private val photo = PickedFile("content://media/2", "IMG_2001.jpg", 50_000, "image/jpeg", width = 4000, height = 3000)

    private fun directChat(session: FakeSessionRepository = FakeSessionRepository()) = ChatViewModel(
        conversationType = ConversationType.DIRECT,
        targetId = alice,
        chatRepository = chat,
        realtimeRepository = realtime,
        sessionRepository = session,
        activeConversations = ActiveConversationRegistry(),
        historyCache = ChatHistoryCache(FakeSessionRepository()),
        attachments = files
    ).also { vm -> CoroutineScope(mainDispatcher.dispatcher).launch { vm.notices.collect { notices += it } } }

    private val ChatViewModel.shown get() = (uiState.value as ChatUiState.Content).messages
    private val fileFrames get() = realtime.sent.filter { it.startsWith("send_message") }

    private fun echo(local: Message, id: Long) = WsEvent.NewMessage(
        message(id = id, from = ME, to = alice, text = local.text).copy(
            type = local.type, clientMsgId = local.clientMsgId, metadataJson = """{"file_id":${local.upload?.fileId}}"""
        )
    )

    @Test
    fun aPickedFileShowsAtOnceUploadsWithProgressAndGoesAsAFileMessageNamedAfterIt() {
        files.picked[pdf.uri] = pdf
        files.uploadGate = CompletableDeferred()
        val vm = directChat()

        vm.sendAttachment(pdf.uri)

        val bubble = vm.shown.single()
        assertEquals(MessageType.FILE, bubble.type)
        assertEquals("the desktop sends the file name as the text", "отчёт.pdf", bubble.text)
        assertEquals(SendState.SENDING, bubble.sendState)
        assertEquals(0f, bubble.upload!!.progress)
        assertEquals(listOf(pdf), files.uploads)

        files.uploadProgress!!(0.5f)
        assertEquals(0.5f, vm.shown.single().upload!!.progress)
        assertEquals("nothing is sent before the file is up", emptyList<String>(), fileFrames)

        files.uploadGate!!.complete(files.uploaded(pdf, id = 31))

        assertEquals(listOf("send_message file direct $alice отчёт.pdf"), fileFrames)
        val metadata = realtime.lastAttachmentMetadata!!
        assertEquals(31L, metadata["file_id"]!!.jsonPrimitive.long)
        assertEquals(2048L, metadata["size"]!!.jsonPrimitive.long)
        assertEquals("application/pdf", metadata["mimeType"]!!.jsonPrimitive.content)
        assertEquals("/api/files/download/31", metadata["url"]!!.jsonPrimitive.content)
        val sending = vm.shown.single()
        assertEquals(31L, sending.upload!!.fileId)
        assertNull("the ring is gone once uploaded", sending.upload!!.progress)

        realtime.emit(echo(sending, id = 80))
        val confirmed = vm.shown.single()
        assertEquals(80L, confirmed.id)
        assertEquals(SendState.SENT, confirmed.sendState)
        assertEquals(1, realtime.sentClientMsgIds.size)
    }

    @Test
    fun aPhotoGoesAsAnImageMessageWithItsSize() {
        files.picked[photo.uri] = photo
        val vm = directChat()

        vm.sendAttachment(photo.uri)

        assertEquals(listOf("send_message image direct $alice IMG_2001.jpg"), fileFrames)
        val metadata = realtime.lastAttachmentMetadata!!
        assertEquals(4000L, metadata["width"]!!.jsonPrimitive.long)
        assertEquals(3000L, metadata["height"]!!.jsonPrimitive.long)
        assertEquals(MessageType.IMAGE, vm.shown.single().type)
    }

    @Test
    fun aFileOutsideThePolicyNeverLeavesAndTheReasonIsShown() {
        files.policyValue = FilePolicy(enabled = true, allowed = listOf("pdf", "jpg"))
        files.picked["content://docs/9"] = PickedFile("content://docs/9", "setup.exe", 10, null)
        val vm = directChat()

        vm.sendAttachment("content://docs/9")

        assertEquals(listOf("Файлы .exe к отправке не разрешены"), notices)
        assertTrue(vm.shown.isEmpty())
        assertTrue(files.uploads.isEmpty())
    }

    @Test
    fun anUnreadableDocumentIsReported() {
        val vm = directChat()
        vm.sendAttachment("content://gone/1")
        assertEquals(listOf("Не удалось прочитать файл"), notices)
    }

    @Test
    fun theServersRefusalFailsTheBubbleWithItsReasonAndRetryUploadsAgain() {
        files.picked[pdf.uri] = pdf
        files.uploadFailure = ApiException(413, null, "Файл больше 20 МБ — такой файл загрузить нельзя")
        val vm = directChat()

        vm.sendAttachment(pdf.uri)

        val failed = vm.shown.single()
        assertEquals(SendState.FAILED, failed.sendState)
        assertEquals("Файл больше 20 МБ — такой файл загрузить нельзя", failed.upload!!.error)
        assertEquals(listOf("Файл больше 20 МБ — такой файл загрузить нельзя"), notices)
        assertEquals(emptyList<String>(), fileFrames)

        vm.retrySend(failed)

        assertEquals(2, files.uploads.size)
        assertEquals(listOf("send_message file direct $alice отчёт.pdf"), fileFrames)
        assertNull(vm.shown.single().upload!!.error)
        assertEquals(SendState.SENDING, vm.shown.single().sendState)
    }

    @Test
    fun aRejectedFrameIsRetriedWithoutUploadingAgain() {
        files.picked[pdf.uri] = pdf
        val vm = directChat()
        vm.sendAttachment(pdf.uri)
        val sending = vm.shown.single()

        realtime.emit(WsEvent.GenericError(context = "send_message", message = "Вложение недоступно", clientMsgId = sending.clientMsgId, code = "ATTACHMENT_NOT_ACCESSIBLE"))
        assertEquals(SendState.FAILED, vm.shown.single().sendState)

        vm.retrySend(vm.shown.single())

        assertEquals("the uploaded file is reused", 1, files.uploads.size)
        assertEquals(2, fileFrames.size)
        assertEquals(listOf(sending.clientMsgId, sending.clientMsgId), realtime.sentClientMsgIds)
    }

    @Test
    fun offlineAFileWaitsQueuedAndGoesUpWhenTheConnectionIsBack() {
        realtime.connectionState.value = ConnectionState.Connecting
        files.picked[pdf.uri] = pdf
        val vm = directChat()

        vm.sendAttachment(pdf.uri)

        assertEquals(SendState.QUEUED, vm.shown.single().sendState)
        assertTrue("nothing goes up offline", files.uploads.isEmpty())

        realtime.connectionState.value = ConnectionState.Connected

        assertEquals(1, files.uploads.size)
        assertEquals(listOf("send_message file direct $alice отчёт.pdf"), fileFrames)
    }

    @Test
    fun anUploadCutByTheNetworkWaitsForTheConnectionInsteadOfFailing() {
        files.picked[pdf.uri] = pdf
        files.uploadGate = CompletableDeferred()
        val vm = directChat()
        vm.sendAttachment(pdf.uri)

        realtime.connectionState.value = ConnectionState.Connecting
        assertEquals("a running upload is not re-queued by the socket", SendState.SENDING, vm.shown.single().sendState)
        files.uploadGate!!.completeExceptionally(ApiException(0, "NETWORK_ERROR", "reset"))

        assertEquals(SendState.QUEUED, vm.shown.single().sendState)
        assertTrue(notices.isEmpty())

        files.uploadGate = null
        realtime.connectionState.value = ConnectionState.Connected
        assertEquals(2, files.uploads.size)
        assertEquals(1, fileFrames.size)
    }

    @Test
    fun cancellingAnUploadStopsItAndRemovesTheBubble() {
        files.picked[pdf.uri] = pdf
        files.uploadGate = CompletableDeferred()
        val vm = directChat()
        vm.sendAttachment(pdf.uri)

        vm.cancelUpload(vm.shown.single())

        assertTrue(vm.shown.isEmpty())
        assertEquals(1, files.cancelledUploads)
        assertEquals(emptyList<String>(), fileFrames)
    }

    @Test
    fun anUploadedFileCannotBeCancelledAnyMore() {
        files.picked[pdf.uri] = pdf
        val vm = directChat()
        vm.sendAttachment(pdf.uri)

        vm.cancelUpload(vm.shown.single())

        assertEquals("the frame is out: only the server's answer settles it", 1, vm.shown.size)
    }

    @Test
    fun aClosedComposerSendsNoFile() {
        files.picked[pdf.uri] = pdf
        val vm = directChat()
        vm.sendMessage("привет")
        realtime.emit(WsEvent.GenericError("send_message", "Сообщение не может быть доставлено", "привет", vm.shown.single().clientMsgId, code = "DM_NOT_ALLOWED"))
        assertEquals(ComposerLock.NOT_DELIVERABLE, vm.composerLock.value)

        vm.sendAttachment(pdf.uri)

        assertTrue(files.uploads.isEmpty())
        assertEquals(1, vm.shown.size)
    }

    @Test
    fun tappingAServerFileDownloadsItAndAnUnsentOneDoesNothing() {
        val vm = directChat()
        val server = message(id = 5, from = alice, to = ME, text = "a.pdf").copy(type = MessageType.FILE, metadataJson = """{"file_id":9}""")

        vm.openAttachment(server)

        assertEquals(listOf(9L), files.downloads)
        assertEquals(TransferState.Ready(File("a.pdf")), vm.opener.transfers.value[9])

        vm.openAttachment(message(id = 6, from = alice, to = ME, text = "просто текст"))
        assertEquals(1, files.downloads.size)
    }

    @Test
    fun aRoleThatCannotUploadGetsNoAttachButton() {
        assertTrue(directChat().canAttach)
        val session = FakeSessionRepository().apply {
            currentUser.value = currentUser.value!!.copy(permissions = RolePermissions(canUploadFiles = false))
        }
        assertEquals(false, directChat(session).canAttach)
    }
}
