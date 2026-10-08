package com.openmychat.mobile.conversations

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.data.model.Channel
import com.openmychat.mobile.data.model.DirectConversation
import com.openmychat.mobile.features.conversations.ConversationsActions
import com.openmychat.mobile.features.conversations.ConversationsContent
import com.openmychat.mobile.features.conversations.ConversationsTab
import com.openmychat.mobile.features.conversations.ConversationsUiState
import com.openmychat.mobile.ui.theme.CentyChatTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class ConversationsContentTest {

    @get:Rule
    val compose = createComposeRule()

    private var retries = 0
    private val actions = object : ConversationsActions {
        override fun onRetry() {
            retries++
        }
    }

    private fun show(
        state: ConversationsUiState,
        tab: ConversationsTab = ConversationsTab.CHATS,
        query: String = "",
        connection: ConnectionState = ConnectionState.Connected
    ) {
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                ConversationsContent(uiState = state, selectedTab = tab, searchQuery = query, connectionState = connection, actions = actions)
            }
        }
    }

    @Test
    fun loadingShowsSkeletonRows() {
        show(ConversationsUiState.Loading)
        compose.onNodeWithTag("skeleton").assertIsDisplayed()
    }

    @Test
    fun anEmptyInboxSaysSo() {
        show(ConversationsUiState.Content(emptyList(), emptyList()))
        compose.onNodeWithText("Пока нет диалогов").assertIsDisplayed()
    }

    @Test
    fun anErrorIsNotABlankListAndRetries() {
        show(ConversationsUiState.Error("java.net.UnknownHostException"))
        compose.onNodeWithText("Не удалось загрузить чаты").assertIsDisplayed()
        compose.onAllNodes(hasText("UnknownHostException", substring = true)).assertCountEquals(0)
        compose.onNodeWithText("Повторить").performClick()
        assertEquals(1, retries)
    }

    @Test
    fun theSearchFieldSaysItSearchesByName() {
        show(ConversationsUiState.Content(listOf(DirectConversation(userId = 2, fullName = "Боб Тестов")), emptyList()))
        compose.onNodeWithText("Люди, каналы, сообщения").assertIsDisplayed()
    }

    @Test
    fun aChannelWithoutMessagesShowsItsMemberCountInRussian() {
        show(
            ConversationsUiState.Content(emptyList(), listOf(Channel(id = 1, name = "Общий", membersCount = 3))),
            tab = ConversationsTab.CHANNELS
        )
        compose.onNodeWithText("3 участника").assertIsDisplayed()
        compose.onAllNodes(hasText("membersCount", substring = true)).assertCountEquals(0)
    }

    @Test
    fun theBannerAppearsWhileReconnecting() {
        show(ConversationsUiState.Content(emptyList(), emptyList()), connection = ConnectionState.Disconnected)
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("connection-banner")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("connection-banner").assertIsDisplayed()
    }
}
