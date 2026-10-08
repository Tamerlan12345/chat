package com.openmychat.mobile.people

import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.features.people.CallAvailability
import com.openmychat.mobile.features.people.PeopleActions
import com.openmychat.mobile.features.people.PeopleContent
import com.openmychat.mobile.features.people.PeopleSearch
import com.openmychat.mobile.features.people.PeopleUiState
import com.openmychat.mobile.features.people.Person
import com.openmychat.mobile.features.people.PersonCardActions
import com.openmychat.mobile.features.people.PersonCardContent
import com.openmychat.mobile.features.people.PersonCardState
import com.openmychat.mobile.ui.theme.CentyChatTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** «Сотрудники» и карточка на устройстве: порядок выдачи, действия карточки, недоступный звонок. */
class PeopleUiTest {

    @get:Rule
    val compose = createComposeRule()

    private val people = listOf(
        Person(id = 1, fullName = "Петров Иван", jobTitle = "Инженер"),
        Person(id = 2, fullName = "Иванова Анна", jobTitle = "Бухгалтер"),
        Person(id = 3, fullName = "Иванов Борис", status = UserStatus.ONLINE),
        Person(id = 4, fullName = "Сидоров Олег", jobTitle = "Иванович-консультант"),
        Person(id = 5, fullName = "Марьиванова Ольга")
    )

    @Test
    fun searchResultsAreShownInRankOrder() {
        val state = PeopleUiState(
            isLoaded = true,
            total = people.size,
            online = 1,
            query = "иван",
            results = PeopleSearch.rank(people, "иван")
        )
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                PeopleContent(state = state, connectionState = ConnectionState.Connected, actions = object : PeopleActions {})
            }
        }
        compose.onNodeWithTag("people-results").assertIsDisplayed()
        // Сверху вниз: фамилия и в сети → фамилия → имя → подстрока → другое поле.
        val shown = listOf(3L, 2L, 1L, 5L, 4L).map { id ->
            compose.onNodeWithTag("person-$id").fetchSemanticsNode().boundsInRoot.top
        }
        assertEquals(shown.sorted(), shown)
    }

    @Test
    fun aDisabledCallSaysWhyUnderTheRowAndWriteOpensTheChat() {
        var written: Person? = null
        val bob = Person(id = 8, fullName = "Боб Тестов", status = UserStatus.OFFLINE, phone = "+7 700 000 00 00")
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                PersonCardContent(
                    state = PersonCardState(person = bob, call = CallAvailability.PEER_OFFLINE),
                    placeholder = bob,
                    actions = object : PersonCardActions {
                        override fun onWrite(person: Person) {
                            written = person
                        }
                    }
                )
            }
        }
        compose.onNodeWithTag("person-call").assertIsNotEnabled()
        compose.onNodeWithTag("person-call-reason").assertIsDisplayed()
        compose.onNodeWithText("Не в сети — звонок сейчас не дойдёт").assertIsDisplayed()
        compose.onNodeWithTag("person-wake").assertIsEnabled()
        compose.onNodeWithText("Мобильный").assertIsDisplayed()
        compose.onNodeWithTag("person-write").assertHasClickAction().performClick()
        assertEquals(8L, written?.id)
    }

    @Test
    fun withoutTheCallPermissionTheReasonIsTheRole() {
        val bob = Person(id = 8, fullName = "Боб Тестов", status = UserStatus.ONLINE)
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                PersonCardContent(
                    state = PersonCardState(person = bob, call = CallAvailability.NOT_PERMITTED),
                    placeholder = bob,
                    actions = object : PersonCardActions {}
                )
            }
        }
        compose.onNodeWithTag("person-call").assertIsNotEnabled()
        compose.onNodeWithText("Звонки недоступны для вашей роли").assertIsDisplayed()
    }

    @Test
    fun anAvailableCallHasNoReasonAndEmptyFieldsAreHidden() {
        var called = false
        val bob = Person(id = 8, fullName = "Боб Тестов", status = UserStatus.ONLINE, jobTitle = "Инженер")
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                PersonCardContent(
                    state = PersonCardState(person = bob, call = CallAvailability.AVAILABLE),
                    placeholder = bob,
                    actions = object : PersonCardActions {
                        override fun onCall(person: Person) {
                            called = true
                        }
                    }
                )
            }
        }
        compose.onNodeWithTag("person-call").assertIsEnabled().performClick()
        assertTrue(called)
        assertEquals(0, compose.onAllNodesWithTag("person-call-reason").fetchSemanticsNodes().size)
        assertEquals("нет телефона — нет строки, не «—»", 0, compose.onAllNodesWithTag("person-info").onChildrenWithText("Мобильный"))
    }

    @Test
    fun theOwnCardOffersEditProfileInsteadOfActions() {
        var edited = false
        val me = Person(id = 1, fullName = "Я Сам")
        compose.setContent {
            CentyChatTheme(darkTheme = false, reduceMotion = true) {
                PersonCardContent(
                    state = PersonCardState(person = me, isSelf = true),
                    placeholder = me,
                    actions = object : PersonCardActions {
                        override fun onEditProfile() {
                            edited = true
                        }
                    }
                )
            }
        }
        assertEquals(0, compose.onAllNodesWithTag("person-write").fetchSemanticsNodes().size)
        compose.onNodeWithTag("person-edit-profile").performClick()
        assertTrue(edited)
    }

    private fun androidx.compose.ui.test.SemanticsNodeInteractionCollection.onChildrenWithText(text: String): Int =
        compose.onAllNodesWithText(text).fetchSemanticsNodes().size

    private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithText(text: String) =
        onAllNodes(androidx.compose.ui.test.hasText(text))
}
