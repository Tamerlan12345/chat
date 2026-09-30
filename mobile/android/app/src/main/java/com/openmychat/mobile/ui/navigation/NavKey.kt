package com.openmychat.mobile.ui.navigation

import kotlinx.serialization.Serializable

@Serializable
sealed interface NavKey {
    @Serializable
    data object ServerConnect : NavKey

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
    ) : NavKey

    @Serializable
    data object Announcements : NavKey

    @Serializable
    data class Call(
        val peerId: Long,
        val peerName: String,
        val isIncoming: Boolean = false
    ) : NavKey

    @Serializable
    data object Profile : NavKey
}
