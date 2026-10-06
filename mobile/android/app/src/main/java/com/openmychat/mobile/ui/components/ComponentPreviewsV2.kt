package com.openmychat.mobile.ui.components

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.ui.theme.CentyChatTheme
import com.openmychat.mobile.ui.theme.CentyTheme

/*
 * UI layer v2 component library previews, light and dark. Static frames (reduce motion on) so
 * screenshot tools render a stable picture; the motion itself is in the debug gallery
 * (src/debug, ComponentGalleryActivity).
 */

@Composable
private fun Plane(color: @Composable () -> Color = { CentyTheme.tokens.canvas }, content: @Composable () -> Unit) {
    CentyChatTheme(reduceMotion = true) {
        Box(Modifier.background(color()).padding(16.dp)) { content() }
    }
}

@Preview(name = "MessageBubble · grouped · light", widthDp = 360)
@Preview(name = "MessageBubble · grouped · dark", widthDp = 360, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun GroupedBubblesPreview() = Plane {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        MessageBubble(own = false, position = BubblePosition.FIRST, text = "Коллеги, отчёт готов.")
        MessageBubble(own = false, position = BubblePosition.MIDDLE, text = "Посмотрите раздел про сроки.")
        MessageBubble(own = false, position = BubblePosition.LAST, text = "До пятницы.", meta = BubbleMeta("09:14"))
        Spacer(Modifier.height(8.dp))
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                MessageBubble(own = true, position = BubblePosition.FIRST, text = "Принято",
                    reply = ReplyPreview("Боб Тестов", "Посмотрите раздел про сроки."))
                MessageBubble(own = true, position = BubblePosition.LAST, text = "Посмотрю сегодня вечером, спасибо!",
                    meta = BubbleMeta("09:15", edited = true, mark = DeliveryMark.READ))
            }
        }
        Spacer(Modifier.height(8.dp))
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
            MessageBubble(own = true, position = BubblePosition.SINGLE, text = "Не дошло",
                meta = BubbleMeta("09:16", mark = DeliveryMark.FAILED), failed = true, onRetry = {}, onDiscard = {})
        }
        MessageBubble(own = false, position = BubblePosition.SINGLE, deleted = true, meta = BubbleMeta("09:17"))
    }
}

@Preview(name = "DeliveryGlyph · states · light")
@Preview(name = "DeliveryGlyph · states · dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun DeliveryGlyphPreview() = Plane {
    Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        DeliveryMark.entries.forEach { DeliveryGlyph(it) }
    }
}

@Preview(name = "TypingBubble + Avatar typing pulse")
@Composable
private fun TypingPreview() = Plane {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        CentyAvatar("Боб Тестов", status = UserStatus.ONLINE, typing = true, ringColor = CentyTheme.tokens.canvas)
        TypingBubble("Собеседник печатает")
    }
}

@Preview(name = "JumpToLatestPill · UnreadPill · DateSeparator · light")
@Preview(name = "JumpToLatestPill · UnreadPill · DateSeparator · dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun PillsPreview() = Plane {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        JumpToLatestPill(visible = true, unseen = 3, onClick = {})
        JumpToLatestPill(visible = true, unseen = 0, onClick = {})
        UnreadPill(12)
        DateSeparator("Вчера")
    }
}

@Preview(name = "ConnectionBanner · states · light", widthDp = 360)
@Preview(name = "ConnectionBanner · states · dark", widthDp = 360, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun BannerPreview() = Plane({ CentyTheme.tokens.list }) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ConnectionBanner(ConnectionState.Disconnected, graceMillis = 0, networkAvailable = false)
        ConnectionBanner(ConnectionState.Connecting, graceMillis = 0, networkAvailable = true)
    }
}

@Preview(name = "SkeletonRow · SkeletonBubble", widthDp = 360, heightDp = 420)
@Composable
private fun SkeletonsPreview() = Plane({ CentyTheme.tokens.list }) {
    Column {
        SkeletonContainer { Column { SkeletonRow(); SkeletonRow(nameFraction = 0.6f) } }
        Box(Modifier.height(260.dp)) { ChatSkeleton() }
    }
}

@Preview(name = "EmptyState · spot illustrations · light", widthDp = 640, heightDp = 170)
@Preview(name = "EmptyState · spot illustrations · dark", widthDp = 640, heightDp = 170, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun IllustrationsPreview() = Plane({ CentyTheme.tokens.list }) {
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Illustration.entries.forEach { SpotIllustration(it) }
    }
}

@Preview(name = "EmptyState · inbox", widthDp = 360, heightDp = 420)
@Composable
private fun EmptyInboxPreview() = Plane({ CentyTheme.tokens.list }) {
    EmptyState(illustration = Illustration.INBOX, title = "Пока нет диалогов", message = "Когда вы или коллега напишете первое сообщение, диалог появится здесь.", actionLabel = "Найти сотрудника", onAction = {})
}

@Preview(name = "SwipeToReply · MessageContextMenu (static)")
@Composable
private fun InteractionPreview() = Plane {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SwipeToReply(onReply = {}) { MessageBubble(own = false, position = BubblePosition.SINGLE, text = "Потяните влево, чтобы ответить") }
        Box { MessageContextMenu(expanded = false, actions = MessageAction.entries, onAction = {}, onDismiss = {}) }
    }
}

@Preview(name = "AcknowledgeButton · light", widthDp = 360)
@Preview(name = "AcknowledgeButton · dark", widthDp = 360, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun AcknowledgePreview() = Plane({ CentyTheme.tokens.elevated }) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        AcknowledgeButton(acknowledged = false, busy = false, onAcknowledge = {})
        AcknowledgeButton(acknowledged = true, busy = false, onAcknowledge = {})
    }
}

@Preview(name = "CallStage · ring, level meter, controls", widthDp = 360)
@Composable
private fun CallStagePreview() {
    CentyChatTheme(darkTheme = true, reduceMotion = true) {
        val tokens = CentyTheme.tokens
        Column(Modifier.background(tokens.frame).padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            BreathingRing(breathing = true) { CentyAvatar("Боб Тестов", size = 120.dp, ringColor = tokens.frame) }
            LevelMeter(level = { 0.2f })
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                CallToggle(Icons.Rounded.Mic, "Микрофон", "Включён", active = false, onClick = {})
                CallControl(Icons.Rounded.CallEnd, "Завершить", tokens.dangerFill, Color.White) {}
            }
        }
    }
}

@Preview(name = "AttachmentTile · file, upload, failed, image", widthDp = 360)
@Composable
private fun AttachmentPreview() = Plane {
    Column(Modifier.widthIn(max = 300.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        FileAttachmentTile("Регламент 2026.pdf", "1,2 МБ", onOpen = {})
        FileAttachmentTile("Смета.xlsx", null, progress = 0.42f)
        FileAttachmentTile("Отчёт.docx", "86 КБ", failed = true, onRetry = {})
        ImageAttachmentTile(aspectRatio = 4f / 3f, placeholder = Color(0xFF8A9BB0), progress = 0.7f)
    }
}
