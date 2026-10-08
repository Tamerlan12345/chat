package com.openmychat.mobile.ui.components

import androidx.compose.animation.BoundsTransform
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Modifier
import androidx.navigation3.ui.LocalNavAnimatedContentScope
import com.openmychat.mobile.ui.theme.CentyMotion

/**
 * Inbox row → chat continuity (UI layer v2): the avatar and the name travel into the chat header.
 * Provided by the navigation only on single-pane layouts with motion on; null everywhere else
 * (list-detail, reduce motion, previews and tests), which turns every shared modifier into a no-op.
 */
val LocalSharedTransitionScope = compositionLocalOf<SharedTransitionScope?> { null }

/** Keys shared by an inbox row and the chat header of the same conversation. */
object SharedKeys {
    fun conversation(isChannel: Boolean, id: Long): String = (if (isChannel) "c-" else "d-") + id
    fun avatar(conversation: String) = "avatar-$conversation"
    fun title(conversation: String) = "title-$conversation"
}

@OptIn(ExperimentalSharedTransitionApi::class)
private val SharedBounds = BoundsTransform { _, _ -> tween(CentyMotion.SHARED, easing = CentyMotion.EaseOutExpo) }

/** Marks this element as the shared one for [key]; nothing at all when sharing is off. */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun Modifier.sharedConversationElement(key: String?): Modifier {
    val scope = LocalSharedTransitionScope.current ?: return this
    if (key == null) return this
    val animated = LocalNavAnimatedContentScope.current
    return with(scope) {
        this@sharedConversationElement.sharedElement(
            sharedContentState = rememberSharedContentState(key),
            animatedVisibilityScope = animated,
            boundsTransform = SharedBounds
        )
    }
}
