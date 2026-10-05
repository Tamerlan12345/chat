package com.openmychat.mobile.chat

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.doubleClick
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.LocalUpload
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.MessageType
import com.openmychat.mobile.data.model.SendState
import com.openmychat.mobile.features.attachments.ImageViewer
import com.openmychat.mobile.features.attachments.MessageAttachment
import com.openmychat.mobile.features.attachments.TransferState
import com.openmychat.mobile.features.chat.ChatActions
import com.openmychat.mobile.features.chat.ChatContent
import com.openmychat.mobile.features.chat.ChatUiState
import com.openmychat.mobile.features.chat.sendStateMark
import com.openmychat.mobile.ui.theme.CentyChatTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** QA D4 / D7: a tap on an attachment opens it, a long press keeps the menu; sending shows progress and can be cancelled. */
class AttachmentUiTest {

    @get:Rule
    val compose = createComposeRule()

    private val me = 1L
    private val peer = 2L
    private val calls = mutableListOf<String>()
    private val transfers = mutableMapOf<Long, TransferState>()

    private val file = Message(
        id = 10, conversationType = ConversationType.DIRECT, targetId = me, senderId = peer, text = "отчёт.pdf",
        type = MessageType.FILE, metadataJson = """{"file_id":42,"size":2048,"mimeType":"application/pdf"}""",
        createdAt = "2026-10-02T09:10:00.000Z", fileOriginalName = "отчёт.pdf"
    )
    private val image = Message(
        id = 11, conversationType = ConversationType.DIRECT, targetId = me, senderId = peer, text = "schema.png",
        type = MessageType.IMAGE, metadataJson = """{"file_id":43}""", createdAt = "2026-10-02T09:11:00.000Z",
        fileOriginalName = "schema.png", fileWidth = 640, fileHeight = 480
    )
    private val own = Message(
        id = 12, conversationType = ConversationType.DIRECT, targetId = peer, senderId = me, text = "Своё сообщение",
        createdAt = "2026-10-02T09:12:00.000Z"
    )

    private val actions = object : ChatActions {
        override val canAttach = true
        override fun canEdit(message: Message) = message.senderId == me
        override fun canDelete(message: Message) = message.senderId == me
        override fun onOpenAttachment(message: Message) {
            calls += "open ${message.id}"
        }
        override fun onCancelUpload(message: Message) {
            calls += "cancel ${message.clientMsgId}"
        }
        override fun transfer(fileId: Long): TransferState? = transfers[fileId]
        // As the chat screen does: queued / failed from the local send state.
        override fun localMark(message: Message) = sendStateMark(message)
    }

    private fun show(vararg messages: Message) {
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                ChatContent(
                    title = "Боб Тестов",
                    isDirect = true,
                    uiState = ChatUiState.Content(messages.toList()),
                    currentUserId = me,
                    connectionState = ConnectionState.Connected,
                    actions = actions
                )
            }
        }
    }

    @Test
    fun aTapOnAFileTileOpensItInsteadOfTheMenu() {
        show(file)

        compose.onNodeWithTag("attachment-file").performClick()

        assertEquals(listOf("open 10"), calls)
        compose.onNodeWithTag("menu-reply").assertDoesNotExist()
    }

    @Test
    fun aLongPressOnAFileTileKeepsTheMenu() {
        show(file)

        compose.onNodeWithTag("attachment-file").performTouchInput { longClick() }

        compose.onNodeWithTag("menu-reply").assertIsDisplayed()
        assertTrue("a long press does not open the file", calls.isEmpty())
    }

    @Test
    fun aTapOnAnImageOpensIt() {
        show(image)

        compose.onNodeWithTag("attachment-image").performClick()

        assertEquals(listOf("open 11"), calls)
    }

    @Test
    fun aTapOnMyOwnTextOffersReplyCopyEditAndDelete() {
        show(own)

        compose.onNodeWithText("Своё сообщение").performClick()

        listOf("Ответить", "Копировать", "Редактировать", "Удалить").forEach { label ->
            compose.onNode(hasText(label) and hasClickAction()).assertIsDisplayed()
        }
    }

    @Test
    fun aDownloadShowsItsProgressAndItsFailureOnTheTile() {
        transfers[42] = TransferState.Running(0.25f)
        show(file)
        compose.onNodeWithText("Скачивание: 25%").assertIsDisplayed()
    }

    @Test
    fun aFailedDownloadSaysWhyOnTheTile() {
        transfers[42] = TransferState.Failed("Нет связи с сервером — файл не скачан")
        show(file)
        compose.onNodeWithText("Нет связи с сервером — файл не скачан").assertIsDisplayed()
    }

    @Test
    fun anUploadShowsItsProgressAndCanBeCancelled() {
        val uploading = own.copy(
            id = -1, text = "план.pdf", type = MessageType.FILE, clientMsgId = "k1", sendState = SendState.SENDING,
            upload = LocalUpload(uri = "content://docs/1", name = "план.pdf", size = 4096, mimeType = "application/pdf", progress = 0.4f)
        )
        show(uploading)

        compose.onNodeWithText("Загрузка: 40%").assertIsDisplayed()
        compose.onNodeWithContentDescription("Отменить загрузку").performClick()

        assertEquals(listOf("cancel k1"), calls)
    }

    @Test
    fun aRefusedUploadShowsTheServersReason() {
        val refused = own.copy(
            id = -2, text = "setup.exe", type = MessageType.FILE, clientMsgId = "k2", sendState = SendState.FAILED,
            upload = LocalUpload(uri = "content://docs/2", name = "setup.exe", size = 10, mimeType = null, error = "Файлы .exe к отправке не разрешены")
        )
        show(refused)

        compose.onNodeWithText("Файлы .exe к отправке не разрешены").assertIsDisplayed()
        compose.onNodeWithTag("failed-row").assertIsDisplayed()
    }

    @Test
    fun theAttachButtonOffersAPhotoOrAFile() {
        show(own)

        compose.onNodeWithTag("composer-attach").performClick()

        compose.onNodeWithTag("attach-photo").assertIsDisplayed()
        compose.onNodeWithTag("attach-file").assertIsDisplayed()
    }

    @Test
    fun theViewerClosesWithItsButtonAndWithASwipeDown() {
        var closed = 0
        val attachment = MessageAttachment(fileId = 43, name = "schema.png", size = 8000, mimeType = "image/png", isImage = true, width = 640, height = 480)
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                ImageViewer(attachment = attachment, thumbnailUrl = null, transfer = TransferState.Running(null), onRetry = {}, onDismiss = { closed++ })
            }
        }

        compose.onNodeWithText("schema.png").assertIsDisplayed()
        compose.onNodeWithContentDescription("Закрыть").performClick()
        assertEquals(1, closed)

        compose.onNodeWithTag("image-viewer").performTouchInput { swipeDown(startY = centerY, endY = bottom) }
        compose.waitForIdle()
        assertEquals(2, closed)
    }

    @Test
    fun aDoubleTapZoomsTheViewerInsteadOfClosingIt() {
        var closed = 0
        val attachment = MessageAttachment(fileId = 43, name = "schema.png", size = 8000, mimeType = "image/png", isImage = true)
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                ImageViewer(attachment = attachment, thumbnailUrl = null, transfer = null, onRetry = {}, onDismiss = { closed++ })
            }
        }

        compose.onNodeWithTag("image-viewer").performTouchInput { doubleClick() }
        compose.waitForIdle()
        compose.onNodeWithTag("image-viewer-zoomed").assertExists()
        // Zoomed in, a drag pans the picture; it does not close the viewer.
        compose.onNodeWithTag("image-viewer").performTouchInput { swipeDown(startY = centerY, endY = bottom) }
        compose.waitForIdle()
        assertEquals(0, closed)
    }

    @Test
    fun aFailedFullImageCanBeRetried() {
        var retried = 0
        val attachment = MessageAttachment(fileId = 43, name = "schema.png", size = 8000, mimeType = "image/png", isImage = true)
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                ImageViewer(attachment = attachment, thumbnailUrl = null, transfer = TransferState.Failed("Файл не найден"), onRetry = { retried++ }, onDismiss = {})
            }
        }
        compose.onNodeWithText("Файл не найден").assertIsDisplayed()
        compose.onNode(hasText("Повторить") and hasClickAction()).performClick()
        assertEquals(1, retried)
    }
}
