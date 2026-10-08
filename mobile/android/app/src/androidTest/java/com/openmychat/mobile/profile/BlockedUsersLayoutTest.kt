package com.openmychat.mobile.profile

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import com.openmychat.mobile.data.model.BlockedUser
import com.openmychat.mobile.features.profile.BlockedUsersContent
import com.openmychat.mobile.features.profile.BlockedUsersState
import com.openmychat.mobile.ui.theme.CentyChatTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** «Заблокированные» at the largest system font: the name is read whole, the button stays reachable. */
class BlockedUsersLayoutTest {

    @get:Rule
    val compose = createComposeRule()

    private fun show(fontScale: Float) = compose.setContent {
        val density = LocalDensity.current
        CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
            CentyChatTheme {
                BlockedUsersContent(
                    state = BlockedUsersState(blocked = listOf(BlockedUser(7, "Никита Белов")), loaded = true),
                    onBack = {},
                    onUnblock = {},
                    onRetry = {}
                )
            }
        }
    }

    private fun nameLayout(): TextLayoutResult {
        val results = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText("Никита Белов").performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(results) }
        return results.first()
    }

    @Test
    fun atFontScaleTwoTheNameIsNotCutOrBrokenInsideAWord() {
        show(fontScale = 2f)

        val layout = nameLayout()
        val cut = (0 until layout.lineCount).filter { layout.isLineEllipsized(it) }
        assertTrue("the name is cut off on lines $cut", cut.isEmpty())
        val text = layout.layoutInput.text.text
        for (line in 0 until layout.lineCount - 1) {
            val end = layout.getLineEnd(line)
            assertTrue("a line breaks inside a word at $end", text[end - 1] == ' ' || text.getOrNull(end) == ' ')
        }
        compose.onNodeWithTag("unblock-7").assertIsDisplayed()
    }
}
