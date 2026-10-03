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
import com.openmychat.mobile.MainActivity
import com.openmychat.mobile.R
import com.openmychat.mobile.data.realtime.ConversationRef
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Уведомления Android: канал «Сообщения», одно уведомление на переписку с тегом
 * `<conversationType>-<targetId>` (как `thread-id` на iOS) — по нему же оно и снимается.
 * Нажатие открывает эту переписку.
 */
@Singleton
class SystemNotificationSink @Inject constructor(
    @ApplicationContext private val context: Context
) : NotificationSink {
    private val manager = context.getSystemService(NotificationManager::class.java)

    override fun show(conversation: ConversationRef, title: String, text: String, chatTitle: String) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            android.os.Build.VERSION.SDK_INT >= 33
        ) return
        ensureChannel()
        val tag = tagOf(conversation)
        val open = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_CONVERSATION_TYPE, conversation.type.value)
            .putExtra(EXTRA_TARGET_ID, conversation.targetId)
            .putExtra(EXTRA_TITLE, chatTitle)
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

    private fun ensureChannel() {
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, context.getString(R.string.notification_channel_messages), NotificationManager.IMPORTANCE_HIGH)
        )
    }

    companion object {
        const val CHANNEL_ID = "messages"
        const val NOTIFICATION_ID = 1
        const val EXTRA_CONVERSATION_TYPE = "com.openmychat.mobile.conversationType"
        const val EXTRA_TARGET_ID = "com.openmychat.mobile.targetId"
        const val EXTRA_TITLE = "com.openmychat.mobile.title"

        fun tagOf(conversation: ConversationRef): String = "${conversation.type.value}-${conversation.targetId}"
    }
}
