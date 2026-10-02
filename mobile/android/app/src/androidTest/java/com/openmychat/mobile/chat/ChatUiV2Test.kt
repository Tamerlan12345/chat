package com.openmychat.mobile.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToKey
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import android.content.ClipboardManager
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.DeliveryStatus
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.features.chat.ChatActions
import com.openmychat.mobile.features.chat.ChatContent
import com.openmychat.mobile.features.chat.ChatUiState
import com.openmychat.mobile.ui.theme.CentyChatTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** UI layer v2 in the chat: grouping, the message menu, reply drafts, the jump pill and the composer. */
class ChatUiV2Test {

    @get:Rule
    val compose = createComposeRule()

    private val me = 1L
    private val peer = 2L
    private val sent = mutableListOf<Pair<String, Long?>>()
    private val edited = mutableListOf<Long>()

    private fun message(id: Long, from: Long, text: String = "Сообщение $id", minute: Long = id % 60, status: DeliveryStatus? = null) = Message(
        id = id, conversationType = ConversationType.DIRECT, targetId = if (from == me) peer else me,
        senderId = from, text = text, createdAt = "2026-10-02T09:%02d:00.000Z".format(minute), deliveryStatus = status
    )

    private val actions = object : ChatActions {
        override fun canEdit(message: Message) = message.senderId == me
        override fun canDelete(message: Message) = message.senderId == me
        override fun onSend(text: String, replyTo: Message?) {
            sent += text to replyTo?.id
        }
        override fun onStartEdit(message: Message) {
            edited += message.id
        }
    }

    private fun show(messages: List<Message>, connection: ConnectionState = ConnectionState.Connected) {
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                ChatContent(
                    title = "Боб Тестов", isDirect = true, uiState = ChatUiState.Content(messages),
                    currentUserId = me, connectionState = connection, actions = actions
                )
            }
        }
    }

    @Test
    fun aGroupShowsItsTimeAndStateOnceOnTheLastBubble() {
        show(listOf(message(1, me, minute = 0, status = DeliveryStatus.READ), message(2, me, minute = 1, status = DeliveryStatus.READ), message(3, me, minute = 2, status = DeliveryStatus.READ)))
        compose.onAllNodesWithTag("delivery-glyph", useUnmergedTree = true).assertCountEquals(1)
    }

    @Test
    fun theMenuOfAnOwnMessageOffersReplyCopyEditDelete() {
        show(listOf(message(1, peer), message(2, me, "Моё")))
        compose.onNodeWithText("Моё").performTouchInput { longClick() }
        listOf("menu-reply", "menu-copy", "menu-edit", "menu-delete").forEach { compose.onNodeWithTag(it).assertIsDisplayed() }
        compose.onNodeWithTag("message-menu-scrim").assertIsDisplayed()
    }

    @Test
    fun theMenuOfSomeoneElsesMessageOffersReplyAndCopyOnly() {
        show(listOf(message(1, peer, "Чужое"), message(2, me)))
        compose.onNodeWithText("Чужое").performTouchInput { longClick() }
        compose.onNodeWithTag("menu-reply").assertIsDisplayed()
        compose.onNodeWithTag("menu-copy").assertIsDisplayed()
        compose.onAllNodes(hasTestTag("menu-edit")).assertCountEquals(0)
        compose.onAllNodes(hasTestTag("menu-delete")).assertCountEquals(0)
    }

    @Test
    fun replyFromTheMenuDraftsAQuoteAboveTheComposerAndSendsWithIt() {
        show(listOf(message(1, peer, "Когда созвон?"), message(2, me)))
        compose.onNodeWithText("Когда созвон?").performTouchInput { longClick() }
        compose.onNodeWithTag("menu-reply").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("reply-banner").assertIsDisplayed()
        compose.onAllNodes(hasTestTag("message-menu-scrim")).assertCountEquals(0)

        compose.onNodeWithTag("composer-field").performTextInput("В три")
        compose.onNodeWithTag("composer-send").performClick()
        compose.waitForIdle()
        assertEquals(listOf("В три" to 1L), sent)
        compose.onAllNodes(hasTestTag("reply-banner")).assertCountEquals(0)
    }

    @Test
    fun theJumpPillShowsWhenReadingFarUpAndTakesTheReaderBack() {
        show((1L..40L).map { message(it, if (it % 2 == 0L) me else peer) })
        compose.onAllNodes(hasTestTag("new-messages-pill")).assertCountEquals(0)

        compose.onNodeWithTag("message-list").performScrollToKey("msg-1")
        compose.waitForIdle()
        compose.onNode(hasTestTag("new-messages-pill") and hasContentDescription("К последним сообщениям")).assertIsDisplayed()

        compose.onNodeWithTag("new-messages-pill").performClick()
        compose.waitForIdle()
        compose.onAllNodes(hasTestTag("new-messages-pill")).assertCountEquals(0)
        compose.onNodeWithText("Сообщение 40").assertIsDisplayed()
    }

    @Test
    fun theComposerGrowsToSixLinesThenScrollsInside() {
        show(listOf(message(1, peer)))
        val field = compose.onNodeWithTag("composer-field")
        field.performTextInput("1")
        val one = field.fetchSemanticsNode().size.height
        field.performTextReplacement((1..3).joinToString("\n"))
        val three = field.fetchSemanticsNode().size.height
        field.performTextReplacement((1..6).joinToString("\n"))
        val six = field.fetchSemanticsNode().size.height
        field.performTextReplacement((1..20).joinToString("\n"))
        val twenty = field.fetchSemanticsNode().size.height
        assertTrue("grows: $one < $three < $six", one < three && three < six)
        assertEquals("capped at six lines", six, twenty)
    }

    @Test
    fun aTypingPeerShowsATypingBubbleAtTheNewestEnd() {
        var typing by mutableStateOf<String?>(null)
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                ChatContent(
                    title = "Боб Тестов", isDirect = true, uiState = ChatUiState.Content(listOf(message(1, peer))),
                    currentUserId = me, connectionState = ConnectionState.Connected, actions = actions, typingUser = typing
                )
            }
        }
        compose.onAllNodes(hasTestTag("typing-bubble")).assertCountEquals(0)
        typing = "Боб Тестов"
        compose.waitForIdle()
        compose.onNodeWithTag("typing-bubble").assertIsDisplayed()
    }

    @Test
    fun menuActionsDispatch() {
        show(listOf(message(1, peer), message(2, me, "Скопируй меня")))

        compose.onNodeWithText("Скопируй меня").performTouchInput { longClick() }
        compose.onNodeWithTag("menu-copy").performClick()
        compose.waitForIdle()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        var copied: String? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            copied = context.getSystemService(ClipboardManager::class.java).primaryClip?.getItemAt(0)?.text?.toString()
        }
        assertEquals("Скопируй меня", copied)

        compose.onNodeWithText("Скопируй меня").performTouchInput { longClick() }
        compose.onNodeWithTag("menu-edit").performClick()
        compose.waitForIdle()
        assertEquals(listOf(2L), edited)

        compose.onNodeWithText("Скопируй меня").performTouchInput { longClick() }
        compose.onNodeWithTag("menu-delete").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Удалить сообщение?").assertIsDisplayed()
    }

    @Test
    fun swipingABubbleInTheChatOpensTheReplyBanner() {
        show(listOf(message(1, peer, "Ответь мне"), message(2, me)))
        compose.onNodeWithText("Ответь мне").performTouchInput {
            swipe(start = centerRight.copy(x = right - 4f), end = centerRight.copy(x = right - 4f - 160.dp.toPx()), durationMillis = 400)
        }
        compose.waitForIdle()
        compose.onNodeWithTag("reply-banner").assertIsDisplayed()
    }
}
