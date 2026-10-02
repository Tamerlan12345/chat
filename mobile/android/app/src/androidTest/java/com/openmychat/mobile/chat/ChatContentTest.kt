package com.openmychat.mobile.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.longClick
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.features.chat.ChatActions
import com.openmychat.mobile.features.chat.ChatContent
import com.openmychat.mobile.features.chat.ChatUiState
import com.openmychat.mobile.ui.theme.CentyChatTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** The chat screen's states and rules, rendered without a server. */
class ChatContentTest {

    @get:Rule
    val compose = createComposeRule()

    private val me = 1L
    private val peer = 2L
    private val deleted = mutableListOf<Long>()
    private var retries = 0

    private fun message(id: Long, from: Long, text: String = "Сообщение $id") = Message(
        id = id, conversationType = ConversationType.DIRECT, targetId = if (from == me) peer else me,
        senderId = from, text = text, createdAt = "2026-10-02T09:%02d:00.000Z".format(id % 60)
    )

    private val actions = object : ChatActions {
        override fun canEdit(message: Message) = message.senderId == me
        override fun canDelete(message: Message) = message.senderId == me
        override fun onDelete(message: Message) {
            deleted += message.id
        }
        override fun onRetry() {
            retries++
        }
    }

    private fun show(state: ChatUiState, connection: ConnectionState = ConnectionState.Connected) {
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                ChatContent(
                    title = "Боб Тестов",
                    isDirect = true,
                    uiState = state,
                    currentUserId = me,
                    connectionState = connection,
                    actions = actions
                )
            }
        }
    }

    @Test
    fun deletingAMessageAsksForConfirmationFirst() {
        show(ChatUiState.Content(listOf(message(1, peer), message(2, me, "Удалите меня"))))

        compose.onNodeWithText("Удалите меня").performTouchInput { longClick() }
        compose.onNode(hasText("Удалить") and hasClickAction()).performClick()

        compose.onNodeWithText("Удалить сообщение?").assertIsDisplayed()
        assertEquals("nothing is deleted before the confirmation", emptyList<Long>(), deleted)

        compose.onNodeWithText("Отмена").performClick()
        compose.onAllNodes(hasText("Удалить сообщение?")).assertCountEquals(0)
        assertEquals(emptyList<Long>(), deleted)

        compose.onNodeWithText("Удалите меня").performTouchInput { longClick() }
        compose.onNode(hasText("Удалить") and hasClickAction()).performClick()
        compose.onNode(hasText("Удалить") and hasClickAction() and hasTestTag("confirm-delete")).performClick()
        assertEquals(listOf(2L), deleted)
    }

    @Test
    fun aNewIncomingMessageWhileScrolledUpShowsAPillInsteadOfJumping() {
        var state by mutableStateOf<ChatUiState>(ChatUiState.Content((1L..40L).map { message(it, if (it % 2 == 0L) me else peer) }))
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                ChatContent(title = "Боб Тестов", isDirect = true, uiState = state, currentUserId = me, connectionState = ConnectionState.Connected, actions = actions)
            }
        }
        compose.onNodeWithTag("message-list").performScrollToIndex(0)
        compose.waitForIdle()

        state = ChatUiState.Content((state as ChatUiState.Content).messages + message(41, peer, "Новое входящее"))
        compose.waitForIdle()

        compose.onNodeWithTag("new-messages-pill").assertIsDisplayed()
        compose.onNodeWithText("1 новое").assertIsDisplayed()
        compose.onAllNodes(hasText("Новое входящее")).assertCountEquals(0) // the reader was not moved

        compose.onNodeWithTag("new-messages-pill").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Новое входящее").assertIsDisplayed()
        compose.onAllNodes(hasTestTag("new-messages-pill")).assertCountEquals(0)
    }

    @Test
    fun aNewMessageAtTheBottomIsFollowed() {
        var state by mutableStateOf<ChatUiState>(ChatUiState.Content((1L..40L).map { message(it, peer) }))
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                ChatContent(title = "Боб Тестов", isDirect = true, uiState = state, currentUserId = me, connectionState = ConnectionState.Connected, actions = actions)
            }
        }
        compose.waitForIdle()

        state = ChatUiState.Content((state as ChatUiState.Content).messages + message(41, peer, "Свежее"))
        compose.waitForIdle()

        compose.onNodeWithText("Свежее").assertIsDisplayed()
        compose.onAllNodes(hasTestTag("new-messages-pill")).assertCountEquals(0)
    }

    @Test
    fun loadingShowsASkeletonNotASpinner() {
        show(ChatUiState.Loading)
        compose.onNodeWithTag("skeleton").assertIsDisplayed()
    }

    @Test
    fun anErrorOffersRetry() {
        show(ChatUiState.Error("boom"))
        compose.onNodeWithText("Не удалось загрузить переписку").assertIsDisplayed()
        compose.onAllNodes(hasText("boom")).assertCountEquals(0) // raw exception text never reaches the screen
        compose.onNodeWithText("Повторить").performClick()
        assertEquals(1, retries)
    }

    @Test
    fun anEmptyChatSaysSo() {
        show(ChatUiState.Content(emptyList()))
        compose.onNodeWithText("Сообщений пока нет").assertIsDisplayed()
    }

    @Test
    fun theConnectionBannerShowsOnlyWhileTheLinkIsDown() {
        show(ChatUiState.Content(listOf(message(1, peer))), connection = ConnectionState.Connecting)
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("connection-banner")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("connection-banner").assertIsDisplayed()
    }

    @Test
    fun noBannerWhileConnected() {
        show(ChatUiState.Content(listOf(message(1, peer))))
        compose.mainClock.advanceTimeBy(3_000)
        compose.onAllNodes(hasTestTag("connection-banner")).assertCountEquals(0)
    }
}
