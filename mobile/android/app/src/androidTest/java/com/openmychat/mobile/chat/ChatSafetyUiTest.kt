package com.openmychat.mobile.chat

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.features.chat.ChatActions
import com.openmychat.mobile.features.chat.ChatContent
import com.openmychat.mobile.features.chat.ChatUiState
import com.openmychat.mobile.features.chat.ComposerLock
import com.openmychat.mobile.ui.theme.CentyChatTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** Report and block in a direct chat, and the closed composer (contracts/registration.md §4). */
class ChatSafetyUiTest {

    @get:Rule
    val compose = createComposeRule()

    private val me = 1L
    private val peer = 2L
    private val calls = mutableListOf<String>()

    private val incoming = Message(
        id = 10, conversationType = ConversationType.DIRECT, targetId = me, senderId = peer,
        text = "Купите слона", createdAt = "2026-10-02T09:10:00.000Z", senderName = "Боб Тестов"
    )

    private val actions = object : ChatActions {
        override val hasPersonMenu = true
        override fun canReport(message: Message) = message.senderId != me
        override fun onReportMessage(message: Message) {
            calls += "report message ${message.id}"
        }
        override fun onReportPeer() {
            calls += "report peer"
        }
        override fun onBlockPeer() {
            calls += "block"
        }
        override fun onUnblockPeer() {
            calls += "unblock"
        }
    }

    private fun show(lock: ComposerLock = ComposerLock.NONE) {
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                ChatContent(
                    title = "Боб Тестов",
                    isDirect = true,
                    uiState = ChatUiState.Content(listOf(incoming)),
                    currentUserId = me,
                    connectionState = ConnectionState.Connected,
                    actions = actions,
                    composerLock = lock
                )
            }
        }
    }

    @Test
    fun theServersRefusalShowsARussianBannerAndClosesTheComposer() {
        show(ComposerLock.NOT_DELIVERABLE)

        compose.onNodeWithText("Сообщение не может быть доставлено", substring = true).assertIsDisplayed()
        compose.onNodeWithTag("composer-field").assertIsNotEnabled()
        compose.onNodeWithTag("composer-send").assertIsNotEnabled()
        compose.onNodeWithText("Отправка недоступна").assertIsDisplayed()
    }

    @Test
    fun aBlockedPeerCanBeUnblockedFromTheBanner() {
        show(ComposerLock.BLOCKED_BY_ME)

        compose.onNodeWithText("Вы заблокировали этого пользователя", substring = true).assertIsDisplayed()
        compose.onNodeWithTag("chat-unblock").performClick()

        assertEquals(listOf("unblock"), calls)
    }

    @Test
    fun blockingFromTheMenuAsksFirst() {
        show()

        compose.onNode(hasContentDescription("Ещё")).performClick()
        compose.onNode(hasTestTag("chat-block")).performClick()
        compose.onNodeWithText("Заблокировать пользователя?").assertIsDisplayed()
        assertEquals("nothing is sent before the confirmation", emptyList<String>(), calls)
        compose.onNodeWithTag("confirm-block").performClick()

        assertEquals(listOf("block"), calls)
    }

    @Test
    fun theMenuReportsThePersonAndALongPressReportsAMessage() {
        show()

        compose.onNode(hasContentDescription("Ещё")).performClick()
        compose.onNode(hasTestTag("chat-report")).performClick()
        compose.onNodeWithText("Купите слона").performTouchInput { longClick() }
        compose.onNode(hasText("Пожаловаться") and hasClickAction()).performClick()
        // The menu hands the action over once its bubble has settled back.
        compose.waitUntil(5_000) { calls.size == 2 }

        assertEquals(listOf("report peer", "report message 10"), calls)
    }
}
