package com.openmychat.mobile.ui.navigation

import kotlinx.serialization.Serializable
import java.util.UUID

/** Every destination of the app. Keys are serializable so back stacks survive process death. */
@Serializable
sealed interface NavKey : androidx.navigation3.runtime.NavKey {
    @Serializable
    data object Login : NavKey

    @Serializable
    data object Conversations : NavKey

    @Serializable
    data class Chat(
        val conversationType: String,
        val targetId: Long,
        val title: String,
        val avatarUrl: String? = null,
        val status: String? = null
    ) : NavKey {
        /** Identity of the conversation, ignoring presentation details such as the peer's status. */
        fun isSameConversation(other: Chat): Boolean =
            conversationType == other.conversationType && targetId == other.targetId
    }

    @Serializable
    data object Announcements : NavKey

    /**
     * A single call attempt. [callId] makes every attempt a distinct entry, so a new call to the same
     * peer always gets a fresh entry-scoped ViewModel instead of a finished one.
     */
    @Serializable
    data class Call(
        val peerId: Long,
        val peerName: String,
        val isIncoming: Boolean = false,
        val callId: String = UUID.randomUUID().toString()
    ) : NavKey

    @Serializable
    data object Profile : NavKey
}

/** Destinations shown in the navigation bar/rail, in display order. Conversations is the start tab. */
val TopLevelRoutes: List<NavKey> = listOf(NavKey.Conversations, NavKey.Announcements, NavKey.Profile)

internal val NavKey.isAuthDestination: Boolean
    get() = this is NavKey.Login
