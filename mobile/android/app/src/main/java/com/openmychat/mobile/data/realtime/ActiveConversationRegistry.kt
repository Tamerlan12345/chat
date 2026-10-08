package com.openmychat.mobile.data.realtime

import com.openmychat.mobile.data.model.ConversationType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import javax.inject.Inject
import javax.inject.Singleton

data class ConversationRef(val type: ConversationType, val targetId: Long)

/**
 * The conversation currently on screen (resumed). Messages arriving there are read immediately, so
 * the conversation list must not count them as unread.
 */
@Singleton
class ActiveConversationRegistry @Inject constructor() {
    private val _active = MutableStateFlow<ConversationRef?>(null)
    val active: StateFlow<ConversationRef?> = _active.asStateFlow()

    fun enter(conversation: ConversationRef) {
        _active.value = conversation
    }

    /** Clears the registration only if [conversation] is still the active one. */
    fun leave(conversation: ConversationRef) {
        _active.update { current -> if (current == conversation) null else current }
    }
}
