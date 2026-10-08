package com.openmychat.mobile.data.notifications

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.openmychat.mobile.MainActivity
import com.openmychat.mobile.data.model.ConversationType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * A tap on one of the app's own message notifications: the chat it opens and the account the
 * notification was shown for (final review I3, M3).
 */
data class NotificationTap(val type: ConversationType, val targetId: Long, val title: String, val account: Long) {
    companion object {
        fun parse(type: String?, targetId: Long, title: String?, account: Long): NotificationTap? {
            val conversation = when (type) {
                "direct" -> ConversationType.DIRECT
                "channel" -> ConversationType.CHANNEL
                else -> return null
            }
            if (targetId <= 0 || account <= 0) return null
            return NotificationTap(conversation, targetId, title.orEmpty(), account)
        }
    }
}

/**
 * Taps handed from [NotificationOpenActivity] to [MainActivity] inside the process. The exported
 * launcher never reads a chat from its intent, so another app cannot open a chat (with a title of
 * its choosing): only this process can offer a tap.
 */
object NotificationTaps {
    private val _pending = MutableStateFlow<NotificationTap?>(null)

    /** The tap not taken yet (MainActivity opens it once the session is ready). */
    val pending: StateFlow<NotificationTap?> = _pending.asStateFlow()

    fun offer(tap: NotificationTap) {
        _pending.value = tap
    }

    /**
     * The tap to open now for [currentAccount], taken once. Signed out (null), it waits for the
     * sign-in; for another account it is dropped — that account's chats are not this one's.
     */
    @Synchronized
    fun take(currentAccount: Long?): NotificationTap? {
        val tap = _pending.value ?: return null
        if (currentAccount == null) return null
        _pending.value = null
        return tap.takeIf { it.account == currentAccount }
    }

    fun clear() {
        _pending.value = null
    }
}

/**
 * The target of every message notification's PendingIntent. Not exported: no other app can start
 * it. It hands the tap to the app in memory and brings [MainActivity] forward, without extras.
 */
class NotificationOpenActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val sink = SystemNotificationSink
        NotificationTap.parse(
            type = intent?.getStringExtra(sink.EXTRA_CONVERSATION_TYPE),
            targetId = intent?.getLongExtra(sink.EXTRA_TARGET_ID, 0L) ?: 0L,
            title = intent?.getStringExtra(sink.EXTRA_TITLE),
            account = intent?.getLongExtra(sink.EXTRA_ACCOUNT, 0L) ?: 0L
        )?.let(NotificationTaps::offer)
        startActivity(
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        )
        finish()
    }
}
