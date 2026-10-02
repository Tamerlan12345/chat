package com.openmychat.mobile.ui.navigation

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.runtime.NavMetadataKey
import androidx.navigation3.runtime.contains
import androidx.navigation3.runtime.metadata
import androidx.navigation3.scene.Scene
import androidx.navigation3.scene.SceneStrategy
import androidx.navigation3.scene.SceneStrategyScope

/** False while a detail entry is shown next to its list, where a back arrow would be redundant. */
val LocalBackButtonVisibility = compositionLocalOf { true }

/** Conversations list and the open chat side by side on medium and wider windows. */
class ListDetailScene<T : Any>(
    override val key: Any,
    override val previousEntries: List<NavEntry<T>>,
    val listEntry: NavEntry<T>,
    val detailEntry: NavEntry<T>
) : Scene<T> {
    override val entries: List<NavEntry<T>> = listOf(listEntry, detailEntry)

    override val content: @Composable () -> Unit = {
        Row(modifier = Modifier.fillMaxSize()) {
            Box(modifier = Modifier.weight(0.4f).fillMaxHeight()) {
                listEntry.Content()
            }
            VerticalDivider()
            CompositionLocalProvider(LocalBackButtonVisibility provides false) {
                Box(modifier = Modifier.weight(0.6f).fillMaxHeight()) {
                    AnimatedContent(
                        targetState = detailEntry,
                        contentKey = { entry -> entry.contentKey },
                        transitionSpec = { fadeIn() togetherWith fadeOut() },
                        label = "ListDetailDetailPane"
                    ) { entry ->
                        entry.Content()
                    }
                }
            }
        }
    }

    override fun equals(other: Any?): Boolean =
        other is ListDetailScene<*> && key == other.key && previousEntries == other.previousEntries &&
            listEntry == other.listEntry && detailEntry == other.detailEntry

    override fun hashCode(): Int =
        listOf(key, previousEntries, listEntry, detailEntry).hashCode()

    companion object {
        fun listPane() = metadata { put(ListKey, true) }
        fun detailPane() = metadata { put(DetailKey, true) }
    }

    object ListKey : NavMetadataKey<Boolean>
    object DetailKey : NavMetadataKey<Boolean>
}

/** Returns a [ListDetailScene] when the window is wide enough and a detail entry is on top. */
class ListDetailSceneStrategy<T : Any>(private val isWideWindow: Boolean) : SceneStrategy<T> {
    override fun SceneStrategyScope<T>.calculateScene(entries: List<NavEntry<T>>): Scene<T>? {
        if (!isWideWindow) return null
        val detailEntry = entries.lastOrNull()?.takeIf { it.metadata.contains(ListDetailScene.DetailKey) }
            ?: return null
        val listEntry = entries.findLast { it.metadata.contains(ListDetailScene.ListKey) } ?: return null
        return ListDetailScene(
            // Keyed by the list so switching chats animates only the detail pane.
            key = listEntry.contentKey,
            previousEntries = entries.dropLast(1),
            listEntry = listEntry,
            detailEntry = detailEntry
        )
    }
}

@Composable
fun <T : Any> rememberListDetailSceneStrategy(isWideWindow: Boolean): ListDetailSceneStrategy<T> =
    remember(isWideWindow) { ListDetailSceneStrategy(isWideWindow) }
