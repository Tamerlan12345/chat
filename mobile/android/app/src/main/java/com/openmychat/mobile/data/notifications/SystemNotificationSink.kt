package com.openmychat.mobile.data.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.openmychat.mobile.R
import com.openmychat.mobile.data.realtime.ConversationRef
import com.openmychat.mobile.data.repository.SessionRepository
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Уведомления Android: канал «Сообщения», одно уведомление на переписку с тегом
 * `<conversationType>-<targetId>` (как `thread-id` на iOS) — по нему же оно и снимается.
 * Нажатие открывает эту переписку — через неэкспортируемую [NotificationOpenActivity] и только для
 * учётной записи, для которой уведомление показано (final review I3, M3).
 */
@Singleton
class SystemNotificationSink @Inject constructor(
    @ApplicationContext private val context: Context,
    private val session: SessionRepository
) : NotificationSink {
    private val manager = context.getSystemService(NotificationManager::class.java)

    override fun show(conversation: ConversationRef, title: String, text: String, chatTitle: String) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            android.os.Build.VERSION.SDK_INT >= 33
        ) return
        // A notification belongs to the account signed in when it is shown; signed out, none is shown.
        val account = session.currentUserId ?: return
        ensureChannel()
        val tag = tagOf(conversation)
        // Explicit and not exported: only this PendingIntent can start it (another app cannot).
        val open = Intent(context, NotificationOpenActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(EXTRA_CONVERSATION_TYPE, conversation.type.value)
            .putExtra(EXTRA_TARGET_ID, conversation.targetId)
            .putExtra(EXTRA_TITLE, chatTitle)
            .putExtra(EXTRA_ACCOUNT, account)
        val pending = PendingIntent.getActivity(
            context,
            tag.hashCode(),
            open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_brand_mark)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setGroup(tag)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        manager.notify(tag, NOTIFICATION_ID, notification)
    }

    override fun cancel(conversation: ConversationRef) {
        manager.cancel(tagOf(conversation), NOTIFICATION_ID)
    }

    /**
     * An incoming call while the app has no socket (push `call`, push.md §5): tapping it opens the
     * app, whose socket then receives the same `call_offer`. It lapses with the call window (30 s).
     */
    override fun showIncomingCall(callerId: Long, callerName: String?) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            android.os.Build.VERSION.SDK_INT >= 33
        ) return
        if (session.currentUserId == null) return
        if (manager.getNotificationChannel(CALLS_CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CALLS_CHANNEL_ID, context.getString(R.string.notification_channel_calls), NotificationManager.IMPORTANCE_HIGH)
            )
        }
        // No chat extras: it only brings the app forward (through the same non-exported activity).
        val open = Intent(context, NotificationOpenActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pending = PendingIntent.getActivity(context, CALL_NOTIFICATION_ID, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val title = context.getString(R.string.notification_incoming_call)
        val notification = NotificationCompat.Builder(context, CALLS_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_brand_mark)
            .setContentTitle(title)
            .setContentText(callerName?.takeIf { it.isNotBlank() } ?: context.getString(R.string.notification_incoming_call_unknown))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setTimeoutAfter(CALL_WINDOW_MS)
            .setContentIntent(pending)
            .build()
        manager.notify("call-$callerId", CALL_NOTIFICATION_ID, notification)
    }

    /** Every notification of the app: the account they were for signed out, or another signed in. */
    override fun cancelAll() {
        manager.cancelAll()
    }

    private fun ensureChannel() {
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, context.getString(R.string.notification_channel_messages), NotificationManager.IMPORTANCE_HIGH)
        )
    }

    companion object {
        const val CHANNEL_ID = "messages"
        const val CALLS_CHANNEL_ID = "calls"
        const val CALL_NOTIFICATION_ID = 2
        const val CALL_WINDOW_MS = 30_000L
        const val NOTIFICATION_ID = 1
        const val EXTRA_CONVERSATION_TYPE = "com.openmychat.mobile.conversationType"
        const val EXTRA_TARGET_ID = "com.openmychat.mobile.targetId"
        const val EXTRA_TITLE = "com.openmychat.mobile.title"
        const val EXTRA_ACCOUNT = "com.openmychat.mobile.account"

        fun tagOf(conversation: ConversationRef): String = "${conversation.type.value}-${conversation.targetId}"
    }
}
